// Poreen — API for the Panthers' run around Ireland.
// GET    /api/runs        → club config + every logged run
// POST   /api/runs        → log a run {name, km, date, code?}
// DELETE /api/runs/:id    → remove a run (needs the x-run-token returned at creation)

import STATIC from "./static.js";

const MAX_KM = 250;

function serveStatic(url) {
  const file = STATIC[url.pathname];
  if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file.body, {
    headers: { "content-type": file.type, "cache-control": "public, max-age=300" },
  });
}

// The API is also used by the Porterstown Panthers website, so allow cross-origin calls.
// No cookies are involved: posting needs the club code, deleting needs the run's own token.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-run-token",
  "access-control-max-age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

const bad = (error, status = 400) => json({ error }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && isoDay(d) === s;
}

async function listRuns(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, runner_key, km, run_date, created_at FROM runs ORDER BY run_date ASC, created_at ASC"
  ).all();
  return json({
    club: env.CLUB_NAME || "Panthers",
    start: env.CHALLENGE_START || "2026-01-01",
    codeRequired: Boolean(env.CLUB_CODE),
    runs: results.map((r) => ({
      id: r.id,
      name: r.name,
      key: r.runner_key,
      km: r.km,
      date: r.run_date,
      created: r.created_at,
    })),
  });
}

async function createRun(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return bad("Send JSON please.");
  }

  if (env.CLUB_CODE) {
    const code = String(body.code ?? "").trim().toLowerCase();
    if (code !== String(env.CLUB_CODE).trim().toLowerCase()) return bad("That club code isn't right.", 403);
  }

  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 32) return bad("Name must be 1–32 characters.");

  const km = Math.round(Number(body.km) * 100) / 100;
  if (!Number.isFinite(km) || km <= 0) return bad("Distance must be more than 0 km.");
  if (km > MAX_KM) return bad(`Distance must be ${MAX_KM} km or less.`);

  const date = String(body.date ?? "");
  if (!validDate(date)) return bad("Pick a valid date.");
  const start = env.CHALLENGE_START || "2000-01-01";
  if (date < start) return bad(`Runs before the challenge start (${start}) don't count.`);
  const tomorrow = isoDay(new Date(Date.now() + 86400000));
  if (date > tomorrow) return bad("That date is in the future.");

  // Keep the first spelling a runner used, so "Ciarán" and "ciarán" stay one person with one name.
  const existing = await env.DB.prepare("SELECT name FROM runs WHERE runner_key = ? ORDER BY created_at LIMIT 1")
    .bind(name.toLowerCase())
    .first();
  const displayName = existing ? existing.name : name;

  const id = crypto.randomUUID();
  const token = randomToken();
  const created = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO runs (id, name, runner_key, km, run_date, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, displayName, name.toLowerCase(), km, date, created, await sha256(token))
    .run();

  return json({ run: { id, name: displayName, key: name.toLowerCase(), km, date, created }, token }, 201);
}

async function deleteRun(req, env, id) {
  const token = req.headers.get("x-run-token") || "";
  if (!token) return bad("Missing token.", 401);
  const res = await env.DB.prepare("DELETE FROM runs WHERE id = ? AND token_hash = ?")
    .bind(id, await sha256(token))
    .run();
  if (!res.meta.changes) return bad("Run not found, or it isn't yours to delete.", 404);
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return serveStatic(url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (url.pathname === "/api/runs") {
        if (req.method === "GET") return await listRuns(env);
        if (req.method === "POST") return await createRun(req, env);
        return bad("Method not allowed.", 405);
      }
      const m = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
      if (m && req.method === "DELETE") return await deleteRun(req, env, m[1]);
      return bad("Not found.", 404);
    } catch (err) {
      console.error(err);
      return bad("Something went wrong on our side.", 500);
    }
  },
};
