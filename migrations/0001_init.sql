CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  runner_key  TEXT NOT NULL,
  km          REAL NOT NULL,
  run_date    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  token_hash  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_runner ON runs (runner_key);
CREATE INDEX IF NOT EXISTS runs_date ON runs (run_date);
