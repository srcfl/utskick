# Dashboard

`${PUBLIC_URL}/dashboard` shows an admin how the newsletter does: the lists, the sends, the sends that wait for approval, and the latest audit entries. It only reads. It has no form and no button, and no page changes anything.

The code is in `src/dashboard.ts`, the tests in `test/dashboard.test.ts`.

## What it shows

### `/dashboard`

- **Lists**, one row for each list in the config: subscribers, addresses suppressed for that list (those who left it), new subscriptions in the last 30 days, and where they came from (`subscriptions.source`, such as `mailchimp-import` or `ftw-web`). "New" goes by `consented_at`, the time the person signed up, so an import of old subscribers adds none. Under the table: how many addresses are suppressed on every list (hard bounces, spam complaints, addresses Mailchimp cleaned).
- **Sends**, the latest 25, newest first: key, kind, created, recipients, sent, delivered, unique opens and unique clicks with their share of mails sent, hard bounces, complaints and unsubscribes. Test sends are hidden; `/dashboard?tests=1` shows them. A list without the open pixel (`opens: false` in the config) shows "no pixel" instead of an open rate.
- **Waiting for approval**: the `request_send` approvals that are pending and not yet expired: the request id, the key, the list, the subject, the recipients when the assistant asked, which assistant asked, which assistants made and last changed the draft it copied, when, and when the request ends. Drafts are shared by every assistant, so the column says when the last change came from another assistant than the one asking. The page cannot link to the approval page. Utskick keeps only the SHA-256 of an approval link ([mcp.md](mcp.md)), and the link itself went to the assistant that asked, so an admin gets it from there.
- **Audit log**: the latest 20 rows of `audit_log`: time, assistant, tool, scope, outcome and the summary of the arguments. What the CLI changed through `/admin` is there too, as `admin-token`, with the route as the tool and counts as the summary.

### `/dashboard/sends/<key>`

- The numbers from `stats()` in `src/send.ts`, the same that `send_stats` and `node cli/utskick.ts stats <key>` give: recipients, sent, delivered, unique and total opens and clicks, hard and soft bounces, complaints, unsubscribes.
- Clicks per link as bars, in the order the links come in the mail: how many mails had a click on the link, and their share of mails sent.
- Delivery status: how many rows are sent, pending, sending, unknown, skipped or failed, and what each means. `unknown`: SES may or may not have the mail (no answer, an SES server error, or a run that stopped between SES and the database); check, then `node cli/utskick.ts retry-unknown <key>` sends them again. `failed`: SES refused that address and the mail did not go out; once the cause is fixed (an unverified sender, say), `node cli/utskick.ts retry-failed <key>` puts them back in line.
- First opens and first clicks over time, as inline SVG: an hour a bar for the 72 hours after the first mail went out, then a day a bar up to day 33. Each mail counts once, at its first open or its first click, so the bars add up to the unique counts. A line under the chart counts any that came after day 33.
- For a live send, its resends; for a resend, the live send it repeats. Each is a link.

Every page ends with a note: opens overstate reading. Apple Mail Privacy Protection loads every image in a mail, the open pixel too, as soon as the mail arrives, and Gmail fetches images through its own proxy. Clicks, and replies to the list's reply-to address, are the honest signal. Replies go to that inbox; Utskick never sees them.

A send key must match `[a-z0-9][a-z0-9-]{1,79}`, as when a send is made. Any other path under `/dashboard` is a 404.

## Signing in

The dashboard signs in an admin the way `/oauth/authorize` and `/approve/` do: `signedInAdmin()` in `src/identity.ts`. In production, Cloudflare Access signs the person in, and Utskick checks the JWT that Access adds (`Cf-Access-Jwt-Assertion`) itself: the signature against the team's keys, the issuer, the audience (`access.audience`) and the expiry. It then looks the address up in `admins` in the config. Under `cf dev`, `DEV_IDENTITY` stands in for Access, as [mcp.md](mcp.md) describes.

- Not signed in: 401, the same "Sign-in needed" page as `/oauth/authorize`. No sign-in set up for the installation: 503.
- Signed in, but not an admin: 403. Unlike `/oauth/authorize`, this page does not repeat the address.
- Who comes before what: without sign-in, every path under `/dashboard` answers 401, so nobody can probe which send keys exist.
- Only GET and HEAD. Anything else is a 405.

### Paths Cloudflare Access must cover

All of them belong to **one** self-hosted Access application for your Utskick host, with a policy that allows the admins' addresses:

| Path | For |
|---|---|
| `dashboard` and `dashboard/*` | this dashboard |
| `oauth/authorize` | an admin connects an assistant |
| `approve/*` | an admin approves or declines a send |

Add the two dashboard paths to the application that already holds `oauth/authorize` and `approve`. Utskick accepts one audience (`access.audience`), and a second Access application would have an AUD tag of its own, so its sign-ins would get a 401. As with every change in Cloudflare, this needs the owner's go-ahead ([setup.md](setup.md)).

A path left out of Access fails closed: without a valid Access JWT, the dashboard answers 401 and shows nothing. Everything else stays public, as [mcp.md](mcp.md) lists.

## Headers

Every response under `/dashboard`, sign-in pages and errors too, carries:

```
Cache-Control: no-store
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
X-Content-Type-Options: nosniff
```

Each page is one HTML document with its CSS inline and its charts as inline SVG: no JavaScript, and no font, image or stylesheet from anywhere else.

The approval and consent pages check the `Origin` of a POST, so another site cannot submit their forms. The dashboard needs no such check: it has no form and changes nothing, so there is nothing to forge. It refuses to be framed, and with no CORS headers a browser keeps other sites from reading it.

## What it does not show, on purpose

- **No address, name, delivery token, SES message id or approval link.** Counts only. Subjects, links, list names, sources, assistant names and audit summaries are escaped, and anything shaped like an address is blanked to `[address]`, as in the audit log. A test renders every page with seeded data and fails if any contact's address or name, any delivery token or message id, or the approval link turns up.
- **Not which admin acted.** The audit log keeps the admin behind each grant and the admin who approved each send, but those are addresses. `/admin/audit`, with the CLI's token, has them.
- **Not who opened or clicked**, or anything else about one reader.
- **Not the mail itself.** The web version is at `/a/<key>`, and an approval page shows the mail it asks about.
- **No actions.** No send, resend, retry or approval. The CLI and the approval page do those.

## Cost on D1

An overview reads `subscriptions` and `suppressions` whole, one row per address, and the deliveries and events of the 25 sends it shows, through the indexes on `deliveries (send_id, …)` and `events (delivery_id, type)`. A send page reads that one send's deliveries and events the same way. With 2,000 subscribers and 25 sends, that is 50,000 delivery rows plus their events, often more than 100,000 rows a view, nearly all of them index entries. To read fewer, lower `sendsShown` in `src/dashboard.ts`. A test runs `EXPLAIN QUERY PLAN` on every query the pages make and fails if one scans `deliveries` or `events`. No new index was needed.
