-- Optional run details, kudos and edit tracking.
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run';
ALTER TABLE runs ADD COLUMN duration_s INTEGER;
ALTER TABLE runs ADD COLUMN note TEXT;
ALTER TABLE runs ADD COLUMN kudos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
