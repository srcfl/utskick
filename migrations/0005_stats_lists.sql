-- Machine opens and clicks, lists a colleague makes through an assistant, and how each list grows.
-- Times are UTC, as in 0001.

-- An open or a click that a machine made, as far as Utskick can tell when it arrives: a link
-- scanner, a mail server's security check, Apple Mail's privacy proxy. Only this flag is kept,
-- never the network or user agent it was judged by (src/tracking.ts).
ALTER TABLE events ADD COLUMN machine INTEGER NOT NULL DEFAULT 0;

-- A soft bounce's kind as SES names it, e.g. MailboxFull: only a full mailbox, twice, suppresses.
ALTER TABLE events ADD COLUMN detail TEXT;

-- Lists a colleague makes through an assistant, for a mailing to people they name: an event's
-- guests, a group of partners. They sit beside the config's lists and share their rules: an
-- unsubscribe link in every mail, suppressions, and an admin who approves each send.
CREATE TABLE lists (
  id TEXT PRIMARY KEY,           -- not one of the config's list ids
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,         -- why these people get mail; the approval page shows it
  reply_to TEXT NOT NULL,        -- the colleague who made it: replies go to them
  client_id TEXT NOT NULL,       -- the assistant that made it
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT                -- emptied and closed; the row stays so old sends keep their list's name
);

-- How each list grows: per day and list, how many joined and how many left. Counts only, so
-- someone who left leaves nothing behind here.
CREATE TABLE list_changes (
  day TEXT NOT NULL,             -- 2026-11-03
  list TEXT NOT NULL,
  joined INTEGER NOT NULL DEFAULT 0,
  departed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, list)
) WITHOUT ROWID;

-- What is known so far: those on a list now, by the day they signed up (an import keeps that day).
-- Those who left before now are not counted, nor their joins, so the months add up to each list's size.
INSERT INTO list_changes (day, list, joined)
  SELECT substr(consented_at, 1, 10), list, COUNT(*) FROM subscriptions WHERE true GROUP BY substr(consented_at, 1, 10), list;
