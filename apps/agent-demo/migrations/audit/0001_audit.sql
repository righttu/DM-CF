CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  user_email TEXT,
  actor_id TEXT,
  role TEXT,
  conversation_id TEXT,
  request_id TEXT,
  server TEXT,
  tool TEXT,
  args_json TEXT,
  sql_text TEXT,
  tables TEXT,
  row_count INTEGER,
  status TEXT,
  reason TEXT,
  duration_ms INTEGER,
  job_id TEXT,
  text_excerpt TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_events(user_email, ts);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_conv ON audit_events(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_events(job_id);
