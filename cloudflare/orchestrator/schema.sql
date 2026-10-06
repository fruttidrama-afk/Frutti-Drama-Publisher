-- Publisher Factory free runtime control plane.
-- Durable business state belongs here; browser/runtime snapshots belong in R2.

CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  generation_target INTEGER NOT NULL DEFAULT 3,
  publication_target INTEGER NOT NULL DEFAULT 1,
  approved_stock INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  github_repo TEXT NOT NULL DEFAULT 'fruttidrama-afk/Frutti-Drama-Publisher',
  github_workflow TEXT NOT NULL DEFAULT 'free-runtime-runner.yml',
  last_generation_at TEXT,
  last_publication_at TEXT,
  last_runner_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('generation','publication')),
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','dispatching','dispatched','running','completed','blocked','failed')),
  lease_until TEXT,
  dispatch_run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(publisher_id, local_day, kind, ordinal),
  FOREIGN KEY(publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS obligations_pending_idx
  ON obligations(status, kind, publisher_id, local_day, ordinal);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incidents_open_idx
  ON incidents(publisher_id, resolved_at);
