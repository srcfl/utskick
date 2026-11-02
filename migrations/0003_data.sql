-- Contact ids are never handed out twice. Without AUTOINCREMENT, SQLite gave the id of a deleted
-- newest contact to the next one, and the old mail's links (deliveries.contact_id) then acted on
-- that new person. SQLite cannot add AUTOINCREMENT to a table, so contacts is rebuilt as it was,
-- with the same columns, unique indexes and ids.
CREATE TABLE contacts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  email_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the address, matches suppressions
  first_name TEXT,
  last_name TEXT,
  country TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- New ids start past every id a delivery has used, also those of contacts deleted since.
INSERT INTO sqlite_sequence (name, seq) SELECT 'contacts_new', MAX(
  COALESCE((SELECT MAX(id) FROM contacts), 0),
  COALESCE((SELECT MAX(contact_id) FROM deliveries), 0));
INSERT INTO contacts_new (id, email, email_hash, first_name, last_name, country, created_at)
  SELECT id, email, email_hash, first_name, last_name, country, created_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;

-- A test send's first name (the CLI's --fname). It is for the test mail only and never touches a contact.
ALTER TABLE sends ADD COLUMN test_name TEXT;

-- The SES webhook counts a contact's soft bounces across all their deliveries.
CREATE INDEX deliveries_contact ON deliveries (contact_id);

-- deliveries.error now keeps SES's error type and HTTP status only. Older rows kept SES's text,
-- which can name the recipient.
UPDATE deliveries SET error = 'text removed' WHERE error LIKE '%@%';
