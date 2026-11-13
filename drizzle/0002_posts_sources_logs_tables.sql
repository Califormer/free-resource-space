DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  time_quality TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  quality_score INTEGER NOT NULL DEFAULT 0,
  is_tutorial INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  keyword_ids TEXT NOT NULL DEFAULT '[]',
  gateway_ids TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX posts_source_external_idx ON posts (source, external_id);
--> statement-breakpoint
CREATE TABLE source_status (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'empty',
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  lag_hours REAL
);
--> statement-breakpoint
CREATE TABLE refresh_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
