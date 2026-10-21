-- Additive only: retain existing request receipts and all User records.
ALTER TABLE idempotency_requests ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS login_attempts (
  phone TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_phone_time ON login_attempts(phone, attempted_at);
