-- The mailer's whole state. Times are UTC, written as 2026-11-02T15:00:00Z.

-- One row per address. Deleted when the address leaves its last list.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the address, matches suppressions
  first_name TEXT,
  last_name TEXT,
  country TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Who is on which list, what they agreed to and when.
CREATE TABLE subscriptions (
  contact_id INTEGER NOT NULL,
  list TEXT NOT NULL,          -- a list id from the config
  consent TEXT NOT NULL,       -- id of the consent text the person saw
  consented_at TEXT NOT NULL,
  source TEXT NOT NULL,        -- mailchimp-import, the form it came from, manual
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (contact_id, list)
) WITHOUT ROWID;

-- Addresses we must not mail. Only the hash is kept, so leaving a list deletes the address.
-- scope is a list id, or '*' for every list (bounces and spam complaints).
CREATE TABLE suppressions (
  email_hash TEXT NOT NULL,
  scope TEXT NOT NULL,         -- a list id, or '*' for every list
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'mailchimp-unsubscribed', 'mailchimp-cleaned', 'manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (email_hash, scope)
) WITHOUT ROWID;

-- One mailing: an issue to a list, a resend to those who did not open it, or a test.
CREATE TABLE sends (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,    -- e.g. newsletter-22, newsletter-22-resend, newsletter-22-test-...
  list TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('live', 'resend', 'test')),
  parent_id INTEGER,           -- the send a resend repeats
  subject TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  reply_to TEXT,
  html TEXT NOT NULL,          -- with merge tags, without internal comments
  content_hash TEXT NOT NULL,  -- makes a repeated create with the same content a no-op
  links TEXT NOT NULL,         -- JSON array; a click on link n redirects to links[n]
  fname_fallback TEXT NOT NULL DEFAULT 'there',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- One row per recipient of a send. The status makes sending resumable:
-- pending -> sending -> sent | failed | skipped. A row left in sending
-- (the Worker died between SES and D1) turns unknown and is not retried by itself.
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  send_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,  -- 128 random bits; in the unsubscribe, click and open URLs
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  message_id TEXT UNIQUE,      -- SES MessageId; bounce and complaint events carry it
  error TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  UNIQUE (send_id, contact_id)
);
CREATE INDEX deliveries_status ON deliveries (send_id, status);

-- What happened to a delivery. No IP address and no user agent.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('delivery', 'open', 'click', 'unsubscribe', 'bounce', 'soft-bounce', 'complaint')),
  link INTEGER,                -- for clicks: the index into sends.links
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX events_delivery ON events (delivery_id, type);
