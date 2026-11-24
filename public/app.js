import { ROUTE, LOOP_KM, locate, describe, trail } from "./route.js";

/* ---------- small helpers ---------- */

const $ = (s) => document.querySelector(s);

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem("poreen:" + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("poreen:" + k, JSON.stringify(v));
    } catch {
      /* private mode etc. — fine */
    }
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtKm = (n) =>
  n >= 100 ? Math.round(n).toLocaleString("en-IE") : (Math.round(n * 10) / 10).toLocaleString("en-IE");

const pad = (n) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toUTC = (s) => new Date(s + "T00:00:00Z");
const addDays = (s, n) => {
  const d = toUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const weekStart = (s) => addDays(s, -((toUTC(s).getUTCDay() + 6) % 7)); // Monday
const monthStart = (s) => s.slice(0, 8) + "01";
const niceDate = (s) => {
  const t = localToday();
  if (s === t) return "today";
  if (s === addDays(t, -1)) return "yesterday";
  return toUTC(s).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};

/* Animals, Boreen-style: one per day, by distance run that day. */
const ANIMALS = [
  [21, "🐆", "21 km+"],
  [15, "🦌", "15–21 km"],
  [10, "🦊", "10–15 km"],
  [5, "🐇", "5–10 km"],
  [0, "🐦", "under 5 km"],
];
const animal = (km) => (km > 0 ? ANIMALS.find(([min]) => km >= min)[1] : "⬛");

const COLORS = ["#c2410c", "#0f766e", "#7c3aed", "#be123c", "#1d4ed8", "#4d7c0f", "#a16207", "#0e7490", "#9d174d", "#4338ca"];
const colorFor = (key) => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const initials = (name) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join("");

/* ---------- state ---------- */

let state = { club: "Panthers", start: localToday(), codeRequired: false, runs: [] };
let period = store.get("period", "all");
let selected = null; // runner key, or null for the whole club
const mine = store.get("mine", {}); // run id → delete token

function runners() {
  const today = localToday();
  const from = period === "week" ? weekStart(today) : period === "month" ? monthStart(today) : "0000";
  const by = new Map();
  for (const r of state.runs) {
    let p = by.get(r.key);
    if (!p) by.set(r.key, (p = { key: r.key, name: r.name, total: 0, runs: 0, pKm: 0, pRuns: 0 }));
    p.name = r.name; // latest spelling wins
    p.total += r.km;
    p.runs += 1;
    if (r.date >= from) {
      p.pKm += r.km;
      p.pRuns += 1;
    }
  }
  return [...by.values()];
}

const clubTotal = () => state.runs.reduce((s, r) => s + r.km, 0);

/* ---------- map ---------- */

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const dark = matchMedia("(prefers-color-scheme: dark)");

const map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.25 });
const routeLatLngs = ROUTE.map((s) => [s.lat, s.lng]);
map.fitBounds(L.latLngBounds(routeLatLngs), { padding: [16, 16] });

// OpenStreetMap tiles; in dark mode they're inverted with CSS (see .dark-tiles in style.css).
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
}).addTo(map);
const setTiles = () => map.getContainer().classList.toggle("dark-tiles", dark.matches);
setTiles();

const routeLine = L.polyline(routeLatLngs, { weight: 3, dashArray: "2 7", lineCap: "round" }).addTo(map);
const townLayer = L.layerGroup().addTo(map);
for (const s of ROUTE.slice(0, -1)) {
  L.circleMarker([s.lat, s.lng], { radius: 3, weight: 1, fillOpacity: 1 })
    .bindTooltip(`${s.name} · ${Math.round(s.at)} km`, { direction: "top" })
    .addTo(townLayer);
}
const trailLine = L.polyline([], { weight: 5, lineCap: "round", opacity: 0.95 }).addTo(map);
const pinLayer = L.layerGroup().addTo(map);

function paintStatic() {
  const route = css("--route");
  routeLine.setStyle({ color: route });
  townLayer.eachLayer((m) => m.setStyle({ color: route, fillColor: css("--surface") }));
  trailLine.setStyle({ color: css("--accent") });
}
paintStatic();
dark.addEventListener("change", () => {
  setTiles();
  paintStatic();
  render();
});

function renderMap(list) {
  pinLayer.clearLayers();

  // Whole club as one panther.
  const total = clubTotal();
  const cp = locate(total);
  L.marker([cp.lat, cp.lng], {
    icon: L.divIcon({ className: "", html: '<div class="club-pin">🐆</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
    zIndexOffset: 1000,
    keyboard: false,
  })
    .bindTooltip(`${esc(state.club)} together · ${fmtKm(total)} km`, { direction: "top", offset: [0, -10] })
    .on("click", () => select(null))
    .addTo(pinLayer);

  // Each runner.
  for (const p of [...list].sort((a, b) => a.total - b.total)) {
    const loc = locate(p.total);
    const sel = p.key === selected;
    L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="pin${sel ? " sel" : ""}" style="background:${colorFor(p.key)}">${esc(initials(p.name))}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      zIndexOffset: sel ? 2000 : 0,
      title: p.name,
    })
      .bindTooltip(`<b>${esc(p.name)}</b> · ${fmtKm(p.total)} km<br>${esc(describe(p.total))}`, {
        direction: "top",
        offset: [0, -14],
      })
      .on("click", () => select(p.key))
      .addTo(pinLayer);
  }

  const who = selected && list.find((p) => p.key === selected);
  const km = who ? who.total : total;
  trailLine.setLatLngs(km > 0 ? trail(km) : []);

  const note = $("#mapNote");
  if (who) {
    note.innerHTML = `Following <b>${esc(who.name)}</b>, ${esc(describe(who.total))}. <button type="button" id="showClub">Show the club</button>`;
    $("#showClub").onclick = () => select(null);
  } else {
    note.textContent = "Showing the whole club's combined trail (🐆). Tap a runner to follow them.";
  }
}

function select(key) {
  selected = key;
  render();
  const p = key && runners().find((r) => r.key === key);
  if (p) {
    const loc = locate(p.total);
    map.flyTo([loc.lat, loc.lng], Math.max(map.getZoom(), 8), { duration: 0.6 });
  }
}

/* ---------- panels ---------- */

function renderClub() {
  const total = clubTotal();
  const p = locate(total);
  $("#clubKm").textContent = fmtKm(total);
  $("#clubWhere").textContent =
    total > 0 ? `The ${state.club} are ${describe(total)}` : `The ${state.club} are on the start line in Dublin`;
  const pct = Math.min(100, (p.lapKm / LOOP_KM) * 100);
  $("#clubBar span").style.width = pct + "%";
  $("#clubBar").setAttribute("aria-valuenow", Math.round(pct));
  const laps = p.laps ? `${p.laps} full lap${p.laps > 1 ? "s" : ""} done · ` : "";
  const people = new Set(state.runs.map((r) => r.key)).size;
  $("#clubSub").textContent = `${laps}${Math.round(pct)}% of the way round · ${people} runner${people === 1 ? "" : "s"} · ${state.runs.length} run${state.runs.length === 1 ? "" : "s"}`;
}

function renderBoard(list) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.period === period);

  const rows = list.filter((p) => (period === "all" ? p.runs : p.pRuns)).sort((a, b) => b.pKm - a.pKm || b.total - a.total);
  const ol = $("#board");
  if (!rows.length) {
    const what = period === "week" ? "this week" : period === "month" ? "this month" : "yet";
    ol.innerHTML = `<li><p class="empty">No runs ${what}. Be the first Panther out of Dublin.</p></li>`;
    return;
  }
  ol.innerHTML = rows
    .map(
      (p, i) => `<li>
        <button type="button" class="runner" data-key="${esc(p.key)}" aria-pressed="${p.key === selected}">
          <span class="rank">${i + 1}</span>
          <span class="who">
            <b><i class="dot" style="background:${colorFor(p.key)}"></i><span>${esc(p.name)}</span></b>
            <small>${esc(describe(p.total))}</small>
          </span>
          <span class="km"><b>${fmtKm(p.pKm)}</b> km<small>${p.pRuns} run${p.pRuns === 1 ? "" : "s"}</small></span>
        </button>
      </li>`
    )
    .join("");
}

function renderFeed() {
  const recent = [...state.runs].sort((a, b) => (b.created > a.created ? 1 : -1)).slice(0, 12);
  const ul = $("#feed");
  if (!recent.length) {
    ul.innerHTML = '<li><span></span><p class="empty">Nothing logged yet.</p></li>';
    return;
  }
  ul.innerHTML = recent
    .map(
      (r) => `<li>
        <span class="emo" aria-hidden="true">${animal(r.km)}</span>
        <span><b>${esc(r.name)}</b> ran ${fmtKm(r.km)} km<span class="when">${niceDate(r.date)}</span></span>
        ${mine[r.id] ? `<button type="button" class="del" data-id="${r.id}">Delete</button>` : "<span></span>"}
      </li>`
    )
    .join("");
}

function shareText(key) {
  const p = runners().find((r) => r.key === key);
  if (!p) return null;
  const today = localToday();
  const perDay = new Map();
  for (const r of state.runs) if (r.key === key) perDay.set(r.date, (perDay.get(r.date) || 0) + r.km);
  let week = "";
  for (let i = 6; i >= 0; i--) week += animal(perDay.get(addDays(today, -i)) || 0);
  return [
    `Poreen ${$("#dayNum").textContent}`,
    `${p.name} · ${fmtKm(p.total)} km`,
    week,
    `📍 ${describe(p.total)}`,
    location.origin + "/",
  ].join("\n");
}

function renderShare() {
  const me = store.get("name", "");
  const text = me && shareText(me.toLowerCase());
  $("#shareCard").hidden = !text;
  if (text) $("#shareText").textContent = text;
}

function renderLegend() {
  $("#legend").innerHTML =
    "<span>One animal per day:</span>" +
    ANIMALS.map(([, e, label]) => `<span>${e} ${label}</span>`).join("") +
    "<span>⬛ rest day</span>";
}

function renderNames() {
  const names = [...new Map(state.runs.map((r) => [r.key, r.name])).values()].sort((a, b) => a.localeCompare(b));
  $("#runnerList").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}

function render() {
  const list = runners();
  const day = Math.max(1, daysBetween(state.start, localToday()) + 1);
  $("#dayNum").textContent = "#" + String(day).padStart(3, "0");
  $("#clubName").textContent = state.club;
  $("#loopKm").textContent = fmtKm(LOOP_KM);
  $("#fDate").min = state.start;
  $("#codeField").hidden = !state.codeRequired;
  $("#fCode").required = state.codeRequired;
  renderClub();
  renderMap(list);
  renderBoard(list);
  renderFeed();
  renderShare();
  renderNames();
}

/* ---------- data ---------- */

async function load() {
  try {
    const res = await fetch("/api/runs", { cache: "no-store" });
    if (!res.ok) throw new Error();
    state = await res.json();
    render();
  } catch {
    $("#logMsg").textContent = "Couldn't load the club's runs. Check your connection.";
    $("#logMsg").className = "msg err";
  }
}

$("#logForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#logBtn");
  const msg = $("#logMsg");
  const name = $("#fName").value.replace(/\s+/g, " ").trim();
  // Match an existing runner's spelling regardless of case.
  const existing = state.runs.find((r) => r.key === name.toLowerCase());
  const body = {
    name: existing ? existing.name : name,
    km: parseFloat(String($("#fKm").value).replace(",", ".")),
    date: $("#fDate").value,
    code: $("#fCode").value,
  };
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "Adding…";
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't save that run.");
    mine[data.run.id] = data.token;
    store.set("mine", mine);
    store.set("name", data.run.name);
    if (state.codeRequired) store.set("code", body.code);
    state.runs.push(data.run);
    msg.textContent = `Nice one. ${fmtKm(data.run.km)} km ${animal(data.run.km)} added.`;
    $("#fKm").value = "";
    select(data.run.key);
    $("#shareCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#feed").addEventListener("click", async (e) => {
  const btn = e.target.closest(".del");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm("Delete this run?")) return;
  btn.disabled = true;
  const res = await fetch(`/api/runs/${id}`, { method: "DELETE", headers: { "x-run-token": mine[id] } });
  if (res.ok || res.status === 404) {
    delete mine[id];
    store.set("mine", mine);
    state.runs = state.runs.filter((r) => r.id !== id);
    render();
  } else {
    btn.disabled = false;
    alert("Couldn't delete that run. Try again.");
  }
});

$("#board").addEventListener("click", (e) => {
  const btn = e.target.closest(".runner");
  if (btn) select(btn.dataset.key === selected ? null : btn.dataset.key);
});

for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    period = b.dataset.period;
    store.set("period", period);
    render();
  });
}

$("#copyBtn").addEventListener("click", async () => {
  const text = $("#shareText").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("#copyBtn").textContent = "Copied!";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("#shareText"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $("#copyBtn").textContent = "Selected, now copy";
  }
  setTimeout(() => ($("#copyBtn").textContent = "Copy"), 1800);
});

if (navigator.share) {
  $("#nativeShareBtn").hidden = false;
  $("#nativeShareBtn").addEventListener("click", () => navigator.share({ text: $("#shareText").textContent }).catch(() => {}));
}

/* ---------- boot ---------- */

$("#fName").value = store.get("name", "");
$("#fCode").value = store.get("code", "");
$("#fDate").value = localToday();
$("#fDate").max = localToday();
renderLegend();
render();
load();
setInterval(() => document.visibilityState === "visible" && load(), 60000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
