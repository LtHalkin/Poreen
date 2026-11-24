// Poreen API: the Porterstown Panthers' run around Ireland.
// The page itself lives on the club website (SITE_PAGE); this Worker stores the runs.
//
// GET    /api/runs              club settings + every run
// POST   /api/runs              log a run {name, km, date, kind?, secs?, note?, code?}  → {run, token}
// PATCH  /api/runs/:id          edit a run (x-run-token from creation, or x-admin-code)
// DELETE /api/runs/:id          delete a run (x-run-token, or x-admin-code)
// POST   /api/runs/:id/kudos    +1 kudos
// POST   /api/admin/check       is this admin code right? (x-admin-code)
// POST   /api/admin/rename      rename or merge a runner {from: key, to: name} (x-admin-code)

const MAX_KM = 160; // 100 miles in one go is plenty
const MAX_RUNS_PER_DAY = 10; // per runner per date: stops accidental double-submits piling up
const KINDS = ["run", "club", "parkrun", "race"];
const NOTE_MAX = 80;

// The club website calls this API from the browser. There are no cookies: logging needs the
// club code, editing or deleting needs the run's own token or the committee's admin code.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-run-token, x-admin-code",
  "access-control-max-age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status) => {
  throw new HttpError(message, status);
};

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison for codes.
function same(a, b) {
  a = String(a ?? "").trim().toLowerCase();
  b = String(b ?? "").trim().toLowerCase();
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns true when this IP has gone over a limit. Fails open if the binding is missing.
async function limited(env, name, req) {
  try {
    if (!env[name]) return false;
    const { success } = await env[name].limit({ key: req.headers.get("cf-connecting-ip") || "local" });
    return !success;
  } catch {
    return false;
  }
}

const isAdmin = (req, env) => Boolean(env.CLUB_ADMIN) && same(req.headers.get("x-admin-code"), env.CLUB_ADMIN);
const isoDay = (d) => d.toISOString().slice(0, 10);

async function body(req) {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b;
  } catch {
    return fail("Send JSON please.");
  }
}

/* ---------- validation ---------- */

function cleanName(v) {
  const name = String(v ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 1 || name.length > 32) fail("Name must be 1 to 32 characters.");
  return name;
}

function cleanKm(v) {
  const km = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(km) || km < 0.1) fail("Distance must be at least 0.1 km.");
  if (km > MAX_KM) fail(`Distance must be ${MAX_KM} km or less.`);
  return km;
}

function cleanDate(v, env) {
  const s = String(v ?? "");
  const d = new Date(s + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || isoDay(d) !== s) fail("Pick a valid date.");
  const start = env.CHALLENGE_START || "2000-01-01";
  if (s < start) fail(`Poreen started on ${start}. Earlier runs don't count.`);
  if (s > isoDay(new Date(Date.now() + 86400000))) fail("That date is in the future.");
  return s;
}

const cleanKind = (v) => (KINDS.includes(v) ? v : "run");

function cleanSecs(v, km) {
  if (v === undefined || v === null || v === "" || v === 0) return null;
  const secs = Math.round(Number(v));
  if (!Number.isFinite(secs) || secs < 60 || secs > 48 * 3600) fail("That time doesn't look right.");
  const pace = secs / km;
  if (pace < 150 || pace > 1800) fail("That time doesn't look right for the distance. Check hours, minutes and seconds.");
  return secs;
}

function cleanNote(v) {
  const note = String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (note.length > NOTE_MAX) fail(`Keep the note to ${NOTE_MAX} characters.`);
  return note || null;
}

/* ---------- handlers ---------- */

const COLUMNS = "id, name, runner_key, km, run_date, created_at, kind, duration_s, note, kudos";
const shape = (r) => ({
  id: r.id,
  name: r.name,
  key: r.runner_key,
  km: r.km,
  date: r.run_date,
  created: r.created_at,
  kind: r.kind || "run",
  secs: r.duration_s ?? null,
  note: r.note ?? null,
  kudos: r.kudos ?? 0,
});

async function listRuns(env) {
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM runs ORDER BY created_at ASC`).all();
  return json({
    club: env.CLUB_NAME || "Panthers",
    start: env.CHALLENGE_START || "2026-01-01",
    codeRequired: Boolean(env.CLUB_CODE),
    runs: results.map(shape),
  });
}

async function createRun(req, env) {
  const b = await body(req);
  if (env.CLUB_CODE && !same(b.code, env.CLUB_CODE)) fail("That club code isn't right.", 403);

  const typed = cleanName(b.name);
  const km = cleanKm(b.km);
  const date = cleanDate(b.date, env);
  const kind = cleanKind(b.kind);
  const secs = cleanSecs(b.secs, km);
  const note = cleanNote(b.note);
  const key = typed.toLowerCase();

  // Keep the first spelling a runner used, so "Ciarán" and "ciarán" stay one person.
  const existing = await env.DB.prepare(
    "SELECT name, (SELECT COUNT(*) FROM runs WHERE runner_key = ?1 AND run_date = ?2) AS today FROM runs WHERE runner_key = ?1 ORDER BY created_at LIMIT 1"
  )
    .bind(key, date)
    .first();
  if (existing && existing.today >= MAX_RUNS_PER_DAY) fail(`That's ${MAX_RUNS_PER_DAY} runs on one day already. Edit one instead?`, 429);
  const name = existing ? existing.name : typed;

  const id = crypto.randomUUID();
  const token = randomToken();
  const created = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO runs (id, name, runner_key, km, run_date, created_at, token_hash, kind, duration_s, note, kudos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
  )
    .bind(id, name, key, km, date, created, await sha256(token), kind, secs, note)
    .run();

  return json({ run: shape({ id, name, runner_key: key, km, run_date: date, created_at: created, kind, duration_s: secs, note, kudos: 0 }), token }, 201);
}

async function findOwned(req, env, id) {
  const row = await env.DB.prepare(`SELECT ${COLUMNS}, token_hash FROM runs WHERE id = ?`).bind(id).first();
  if (!row) fail("That run doesn't exist any more.", 404);
  if (isAdmin(req, env)) return row;
  const token = req.headers.get("x-run-token") || "";
  if (!token || (await sha256(token)) !== row.token_hash) fail("You can only change runs you logged on this device.", 403);
  return row;
}

async function editRun(req, env, id) {
  const row = await findOwned(req, env, id);
  const b = await body(req);
  const km = b.km !== undefined ? cleanKm(b.km) : row.km;
  const date = b.date !== undefined ? cleanDate(b.date, env) : row.run_date;
  const kind = b.kind !== undefined ? cleanKind(b.kind) : row.kind;
  const secs = b.secs !== undefined ? cleanSecs(b.secs, km) : row.duration_s !== null ? cleanSecs(row.duration_s, km) : null;
  const note = b.note !== undefined ? cleanNote(b.note) : row.note;
  await env.DB.prepare("UPDATE runs SET km = ?, run_date = ?, kind = ?, duration_s = ?, note = ?, updated_at = ? WHERE id = ?")
    .bind(km, date, kind, secs, note, new Date().toISOString(), id)
    .run();
  return json({ run: shape({ ...row, km, run_date: date, kind, duration_s: secs, note }) });
}

async function deleteRun(req, env, id) {
  await findOwned(req, env, id);
  await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function kudos(env, id) {
  const row = await env.DB.prepare("UPDATE runs SET kudos = kudos + 1 WHERE id = ? RETURNING kudos").bind(id).first();
  if (!row) fail("That run doesn't exist any more.", 404);
  return json({ kudos: row.kudos });
}

async function rename(req, env) {
  if (!isAdmin(req, env)) fail("That admin code isn't right.", 403);
  const b = await body(req);
  const from = String(b.from ?? "").toLowerCase();
  const to = cleanName(b.to);
  const toKey = to.toLowerCase();
  // Merging into someone who already exists keeps their spelling.
  const target = await env.DB.prepare("SELECT name FROM runs WHERE runner_key = ? ORDER BY created_at LIMIT 1").bind(toKey).first();
  const finalName = target && toKey !== from ? target.name : to;
  const res = await env.DB.prepare("UPDATE runs SET name = ?, runner_key = ? WHERE runner_key = ?").bind(finalName, toKey, from).run();
  if (!res.meta.changes) fail("No runs found for that runner.", 404);
  return json({ changed: res.meta.changes, name: finalName, key: toKey });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (!path.startsWith("/api")) {
      // The Poreen page lives on the club website.
      return Response.redirect(env.SITE_PAGE || "https://porterstown-panthers.pages.dev/poreen", 302);
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (req.method !== "GET") {
        if (await limited(env, "WRITE_LIMIT", req)) fail("Slow down a little. Try again in a minute.", 429);
        if ((req.headers.has("x-admin-code") || path.startsWith("/api/admin")) && (await limited(env, "ADMIN_LIMIT", req)))
          fail("Too many tries. Wait a minute and try again.", 429);
      }
      if (path === "/api/runs") {
        if (req.method === "GET") return await listRuns(env);
        if (req.method === "POST") return await createRun(req, env);
      }
      let m = path.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
      if (m && req.method === "PATCH") return await editRun(req, env, m[1]);
      if (m && req.method === "DELETE") return await deleteRun(req, env, m[1]);
      m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/kudos$/);
      if (m && req.method === "POST") return await kudos(env, m[1]);
      if (path === "/api/admin/check" && req.method === "POST") {
        if (!isAdmin(req, env)) fail("That admin code isn't right.", 403);
        return json({ ok: true });
      }
      if (path === "/api/admin/rename" && req.method === "POST") return await rename(req, env);
      return json({ error: "Not found." }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on our side. Try again." }, 500);
    }
  },
};
