-- What the security review of 2026-11-02 asked of the assistants' side (docs/mcp.md).
-- Times are UTC, as in 0001.

-- Drafts are shared by every assistant, so each records who made it. The last one to save it
-- is drafts.client_id already.
ALTER TABLE drafts ADD COLUMN created_by TEXT;     -- NULL for drafts made before this migration

-- A send request keeps the grant that asked, so revoking that grant withdraws it, and who wrote
-- the draft it copied, for the approval page.
ALTER TABLE approvals ADD COLUMN grant_id TEXT;
ALTER TABLE approvals ADD COLUMN draft_created_by TEXT;
ALTER TABLE approvals ADD COLUMN draft_changed_by TEXT;

-- The hash of the code or refresh token a token was issued for. A refresh retried within the
-- grace ends what the first answer issued, so one chain of tokens lives on, not two.
ALTER TABLE oauth_tokens ADD COLUMN parent TEXT;
CREATE INDEX oauth_tokens_parent ON oauth_tokens (parent);

-- One row per test_send, taken before it sends: the hourly cap holds however many calls come at once.
CREATE TABLE test_send_slots (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX test_send_slots_at ON test_send_slots (at);

-- One row per dynamic registration, for a day: the cap per client address. The address is
-- kept only as its SHA-256.
CREATE TABLE oauth_registrations (
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX oauth_registrations_source ON oauth_registrations (source, at);
