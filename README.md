# Poreen API 🐆

The backend for **Poreen**, the Porterstown Panthers' run around Ireland. Members log their km and
move along a 2,454 km route of real roads and greenways, past 30 checkpoints from Hook Lighthouse
to Malin Head. The page is on the club website at **/poreen**
([LtHalkin/Porterstown-Panthers-](https://github.com/LtHalkin/Porterstown-Panthers-)); the route,
map, leaderboard, stamps and share pictures are all built there.

This repo is a small Cloudflare Worker with a D1 (SQLite) database that stores the runs.
Opening the Worker's own address (https://poreen.cianop101.workers.dev) redirects to the club page.

## API

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/runs` | Club settings and every run |
| `POST` | `/api/runs` | Log a run: `{name, km, date, kind?, secs?, note?, code}`. Returns the run and a token for editing it later |
| `PATCH` | `/api/runs/:id` | Edit a run (header `x-run-token`, or `x-admin-code`) |
| `DELETE` | `/api/runs/:id` | Delete a run (header `x-run-token`, or `x-admin-code`) |
| `POST` | `/api/runs/:id/kudos` | Add one kudos |
| `POST` | `/api/admin/check` | Check a committee code (`x-admin-code`) |
| `POST` | `/api/admin/rename` | Rename or merge a runner: `{from: key, to: name}` (`x-admin-code`) |

`kind` is `run`, `club`, `parkrun` or `race`. `secs` is the run time in seconds (optional).
Runs are limited to 160 km, with a sensible pace, dated from the challenge start to tomorrow.
Writes are rate-limited per IP address.

## Settings

| What | Where |
| --- | --- |
| Club name | `CLUB_NAME` in `wrangler.jsonc` |
| Start date (day #001; earlier runs are refused) | `CHALLENGE_START` in `wrangler.jsonc` |
| Where the Worker's own address redirects | `SITE_PAGE` in `wrangler.jsonc` |
| Club code members need to log a run | secret `CLUB_CODE` |
| Committee code (edit or delete any run, rename or merge runners, export) | secret `CLUB_ADMIN` |

Change a secret with `npx wrangler secret put CLUB_CODE` (or `CLUB_ADMIN`).
The committee tools are at the bottom of the Poreen page under **Good to know › Committee tools**.

## Starting a new season

Back up, wipe, and move the start date:

```sh
npx wrangler d1 execute poreen --remote --command "SELECT * FROM runs" --json > runs-backup.json
npx wrangler d1 execute poreen --remote --command "DELETE FROM runs"
# then set CHALLENGE_START in wrangler.jsonc and deploy
```

## Develop and deploy

```sh
npm install
printf 'CLUB_CODE=panthers\nCLUB_ADMIN=test-admin\n' > .dev.vars
npm run db:migrate:local
npm run dev        # API on http://localhost:8787
npm run db:migrate # apply new migrations to the live database
npm run deploy
```

To point a local copy of the club site at a local API: `PUBLIC_POREEN_API=http://localhost:8787 npm run dev`.
