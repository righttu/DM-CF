ALTER TABLE audit_events ADD COLUMN call_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_call ON audit_events(call_id);
