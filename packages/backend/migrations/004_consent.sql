-- The consent gate's receipts (docs/CONFIGURATION.md, "Permissions and the consent gate").
-- Runs every boot like the others, so every statement is IF NOT EXISTS.
--
-- One row per gated action the gate looked at (allowed, denied or expired) and one per change the person made
-- (granted, revoked, mode_changed). Receipts are always on, in either mode. `summary` is at most 200 characters and
-- has been through the secret scrubber; it is never the whole command or message. Rows older than 90 days are pruned at boot.
CREATE TABLE IF NOT EXISTS consent_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                 -- ISO 8601, UTC
  capability TEXT NOT NULL,         -- app_write | shell | ... | '*' for a mode change
  grant_id TEXT,                    -- the grant or override that decided it, when one did
  harness TEXT NOT NULL DEFAULT '', -- claude | codex | dsh | server | app
  thread_id TEXT,
  tool_or_route TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL             -- allowed | denied | expired | granted | revoked | mode_changed
);
CREATE INDEX IF NOT EXISTS idx_consent_receipts_ts ON consent_receipts(ts);
CREATE INDEX IF NOT EXISTS idx_consent_receipts_cap ON consent_receipts(capability, id);
