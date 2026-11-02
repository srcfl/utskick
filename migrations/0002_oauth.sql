-- Assistants that connect over MCP: who they are, what an admin let them do, what they wrote,
-- the sends they asked for, and every call they made. Times are UTC, as in 0001.
-- No token, code or approval link is stored as itself: each table keeps its SHA-256.

-- Clients that registered themselves (RFC 7591). A client named by a metadata document URL
-- is fetched when it signs in and not stored.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  secret_hash TEXT,              -- NULL for a public client
  auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  name TEXT NOT NULL,
  uri TEXT,
  redirect_uris TEXT NOT NULL,   -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- An authorization request a signed-in admin has on screen and has not answered yet.
CREATE TABLE oauth_consents (
  id_hash TEXT PRIMARY KEY,      -- the secret in the consent form
  subject TEXT NOT NULL,         -- the admin's address, from the identity check
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  redirect_given INTEGER NOT NULL,
  state TEXT,
  challenge TEXT NOT NULL,       -- PKCE S256
  scope TEXT NOT NULL,           -- the scopes offered, space separated
  expires_at TEXT NOT NULL
);

-- One admin's yes to one client. Its tokens hang off it, and revoking it ends them all.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  subject TEXT NOT NULL,         -- the admin who approved
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,        -- the MCP endpoint; every token's audience
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL,      -- refreshing never takes a grant past this
  used_at TEXT
);
CREATE INDEX oauth_grants_client ON oauth_grants (client_id);

-- Authorization codes, access tokens and refresh tokens. A spent code or refresh token stays,
-- marked, so that a second use is caught and ends its grant.
CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  challenge TEXT,                -- code only
  redirect_uri TEXT,             -- code only
  redirect_given INTEGER,        -- code only: the token request must name it again
  uses INTEGER NOT NULL DEFAULT 0,
  used_at TEXT
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);

-- Drafts an assistant writes. A live send is made from a copy taken when it is requested.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,           -- d-<hex>
  list TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,            -- with merge tags, as sends.html
  markdown TEXT,                 -- the source, for a draft written in Markdown
  client_id TEXT NOT NULL,       -- the client that saved it last
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- A request to send a draft to a list. An admin approves or declines it once, within ten minutes.
-- pending -> approved -> sent, or pending -> declined; failed when the send could not be created.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,           -- a-<hex>; the assistant asks about it by this
  token_hash TEXT NOT NULL UNIQUE,  -- the secret in the approval link
  draft_id TEXT NOT NULL,
  send_key TEXT NOT NULL,
  list TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,            -- what is approved is what goes out, whatever happens to the draft
  recipients INTEGER NOT NULL,   -- from a dry run when the request was made
  client_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,    -- the admin whose grant the assistant used
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'declined', 'approved', 'sent', 'failed')),
  decided_by TEXT,
  decided_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX approvals_status ON approvals (status);

-- Every tool call, and every decision on a send. No subscriber addresses and no bodies.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  client_id TEXT NOT NULL,
  subject TEXT,                  -- the admin whose grant the call used
  scope TEXT,                    -- the scope the tool needs
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,         -- JSON
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied', 'approved', 'declined')),
  approved_by TEXT               -- for a send: who approved or declined it
);
