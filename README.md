# Poreen 🐆

The Panthers run the island. Everyone logs their km, and every runner gets a marker on a
1,528 km loop around Ireland (Dublin → Wexford → Cork → Kerry → Galway → Donegal → Belfast → Dublin).
The whole club also travels the loop together as one panther. There's a week / month / all-time
leaderboard, and a Boreen-style result you can share:

```
Poreen #012
Aoife · 235 km
🐇🦊⬛🐇🐆⬛🐦
📍 past Kenmare, 31 km to Waterville
```

One animal per day: 🐦 under 5 km · 🐇 5–10 · 🦊 10–15 · 🦌 15–21 · 🐆 21 km+ · ⬛ rest day.

Live at **https://poreen.cianop101.workers.dev**, and on the Porterstown Panthers website at `/poreen`
(same database: the API allows cross-origin requests for that).

## How it's built

- `public/`: the page (plain HTML/CSS/JS + Leaflet with OpenStreetMap tiles). The route is in `public/route.js`.
- `src/worker.js`: a Cloudflare Worker that serves the page and a small API on a D1 (SQLite) database.
- `scripts/bundle-static.mjs`: inlines `public/` into the Worker on every `dev`/`deploy`.

## Settings

| What | Where |
| --- | --- |
| Club name | `CLUB_NAME` in `wrangler.jsonc` |
| Start date (day #001; earlier runs are refused) | `CHALLENGE_START` in `wrangler.jsonc` |
| Club code needed to log a run | secret: `npx wrangler secret put CLUB_CODE` (`npx wrangler secret delete CLUB_CODE` to turn it off) |

Runners can delete their own runs from the device they logged them on. To remove anyone's run:

```sh
npx wrangler d1 execute poreen --remote --command "SELECT id, name, km, run_date FROM runs ORDER BY created_at DESC LIMIT 20"
npx wrangler d1 execute poreen --remote --command "DELETE FROM runs WHERE id = '...'"
```

## Develop and deploy

```sh
npm install
npm run db:migrate:local
npm run dev        # http://localhost:8787
npm run deploy
```
