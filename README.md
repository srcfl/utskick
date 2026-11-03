# Utskick

Utskick (Swedish for 'a mailing') is an open source newsletter sender on Cloudflare Workers and Amazon SES.

You keep the list, the templates and the numbers. Amazon SES only delivers the mail. It was built to replace Mailchimp for [Sourceful Energy](https://sourceful.energy)'s newsletter, reads Mailchimp's exports and merge tags, and costs a few kronor a month to run.

## What it does

- **Sends** an HTML issue to a list, one mail per recipient, with the merge tags `*|FNAME|*`, `*|UNSUB|*` and `*|ARCHIVE|*`. A send that stops halfway resumes without mailing anyone twice.
- **One-click unsubscribe** ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)): the `List-Unsubscribe` headers that Gmail, Yahoo and Apple Mail act on, plus the footer link.
- **Counts** clicks per link, and opens through an optional pixel per list, which feeds a resend to those who did not open. Clicks by link scanners at mail servers and opens by Apple Mail's privacy proxy are counted apart from people's, so a B2B list does not look busier than it is.
- **Numbers that matter:** open, click, click-to-open, unsubscribe, bounce and complaint rates per send; sending health over 30 days against the limits Amazon SES and Gmail hold senders to; and each list's growth by month.
- **Bounces and spam complaints** arrive from SES through SNS; each message's signature is checked, and the address is suppressed.
- **Imports** a Mailchimp audience export: subscribers with their opt-in time, unsubscribed and cleaned addresses as suppressions.
- **Sign-ups** from your own sites: a browser form, a server route with a key, or a Cloudflare Worker over a service binding ([docs/signup.md](docs/signup.md)).
- **A dashboard** for the team with sending health, lists and their growth, sends, rates, clicks per link and the audit log, and no personal data ([docs/dashboard.md](docs/dashboard.md)).
- **An MCP server** for everyone at the company, through their own assistant (Claude, ChatGPT, Grok, Cursor, Codex …), with OAuth 2.1. An assistant reads the numbers, writes drafts, sends tests to the person using it, and makes lists for one mailing, such as an event's guests. It can only *ask* to send to a list: an admin gets the request by mail and approves each send ([docs/mcp.md](docs/mcp.md)).
- **A web archive** page per issue, without names or tracking.

## Architecture

```
issue HTML ──► CLI ──/admin──► Worker ──SendEmail──► Amazon SES ──► inbox
                                 ▲  │                     │
   readers: /u /c /o /a ─────────┤  ├── D1 (lists, sends, │
   sites:   /subscribe, RPC ─────┤  │   events, OAuth)    └─ SNS ──► /hooks/ses
   assistants: /mcp + OAuth ─────┤  └── R2 (images)
   admins:  /dashboard, /approve ┘      cron: sends what a person approved
```

- **Worker** (`src/`): one Cloudflare Worker. It keeps contacts, lists, sends, deliveries, events and OAuth state in D1, sends through the SES v2 API, and serves everything readers, sites, assistants and admins reach.
- **CLI** (`cli/utskick.ts`): Node 24 or later, no build step. It imports exports and drives sends through the Worker's `/admin` API. It never talks to SES itself.
- **Config** (`config/*.json`): your organization, lists, senders, forms, admins, and where the installation runs. Code holds nothing specific to one installation.

### How a send works

1. `send … --dry-run` counts the audience (subscribers of the list, minus suppressed addresses), lists the links it will track, and writes a sample mail to `.dev/`.
2. A live send needs `--confirm <count>`, the number the dry run printed. Without it nothing goes out.
3. Creating a send writes one delivery row per recipient, each with a random token. Creating it again with the same content does nothing; other content under the same key is refused.
4. The CLI asks the Worker for batches of up to 14 mails (SES's default rate), one batch a second. Each row is claimed before SES is called and settled as soon as SES answers, so a stopped send resumes where it stopped (`resume <key>`). When SES's answer is lost or SES answers with a server error, the row becomes `unknown` and is not retried on its own ("rather none than two"); `retry-unknown` sends those again. An address SES refuses is `failed` (`retry-failed` puts those back in line). An account or settings error (access denied, sending paused, an unverified domain or the SES sandbox, the day's quota spent, or SES refusing every mail of a batch the same way) stops the send with the rest pending: fix the cause, then `resume`. A row whose answer was lost turns `sent` by itself when SES's delivery event for it arrives. After the last batch the CLI says if any rows are still sending, unknown or failed, and what to run.
5. Unsubscribes, bounces and complaints are checked again at send time.

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars && cp .env.example .env
npm run dev                # local Worker on :5173 with config/example.json, local D1 and R2
npm run ses-mock           # in another terminal: SES stand-in on :4566, mail lands in .dev/outbox/
npm run db:local           # create the tables in the local D1
npm test                   # node:test; D1 runs on node:sqlite, SES is faked
```

In development mode links point at `localhost`, SES calls go to the mock, and sign-in is a stand-in admin that works only on a local host, so a local run cannot reach a real inbox.

Then, against the local Worker:

```bash
node cli/utskick.ts import <mailchimp-export-dir> --list newsletter
node cli/utskick.ts send issue.html --list newsletter --key newsletter-1 --subject "…" --dry-run
node cli/utskick.ts send issue.html --list newsletter --key newsletter-1 --subject "…" --test you@example.com --fname You
node cli/utskick.ts send issue.html --list newsletter --key newsletter-1 --subject "…" --confirm <count>
node cli/utskick.ts resend issue.html --list newsletter --parent newsletter-1 --subject "…" --after-days 3 --confirm <count>
node cli/utskick.ts stats newsletter-1
node cli/utskick.ts resume newsletter-1          # carry on after a stop
node cli/utskick.ts retry-unknown newsletter-1   # send again what SES may not have got
node cli/utskick.ts retry-failed newsletter-1    # send again what SES refused
```

`--fname` is used in that test mail only; it never changes a contact. A resend to those who did not open needs the list's open pixel and is refused without it.

Images next to the issue HTML (`src="hero.jpg"`) are uploaded to R2 and served from `/img/<sha256>.jpg`.

## Your own installation

1. Copy `config/example.json` to `config/<you>.json` and fill it in: the `deploy` section (public URL, AWS region, D1, R2), your organization, lists, forms and admins.
2. Follow [docs/setup.md](docs/setup.md) for SES, DNS, SNS, IAM, D1, R2, Cloudflare Access and the secrets.
3. Apply the migrations first (`cf d1 migrations apply <d1-id>`), then deploy with `UTSKICK_CONFIG=config/<you>.json npx cf deploy`. Code that ships before its migration answers readers' clicks with errors. Without `UTSKICK_CONFIG` a deploy stops, so nobody ships mail whose links point at someone else's Worker.

More: [docs/signup.md](docs/signup.md) (forms), [docs/dashboard.md](docs/dashboard.md), [docs/mcp.md](docs/mcp.md) (assistants), [docs/examples/](docs/examples/) (connecting a Cloudflare Pages site).

## Security model

- **Admin API.** `/admin` takes a bearer token, compared in constant time; changing calls are written to the audit log. The token, the AWS key, the SNS topic ARN and the form keys are Worker secrets, never files in the repository. Consider putting `/admin` behind a Cloudflare Access service token as well.
- **AWS key.** An IAM user allowed `ses:SendEmail` on one identity and one configuration set, and nothing else.
- **SNS webhook.** Nothing in a message is used before its signature checks out: SignatureVersion 1 or 2, the signing certificate fetched only from `sns.<the topic's region>.amazonaws.com` with the `SimpleNotificationService-…pem` path, and only the configured topic accepted. That includes a subscription confirmation's `SubscribeURL`.
- **Reader tokens.** Each delivery has its own 128-bit random token, used in its unsubscribe, click and open URLs. A token identifies one mail, not a person, and the API never returns one. Like any newsletter footer link, a forwarded mail lets its new reader unsubscribe the original one.
- **Unsubscribe.** A GET only shows a button, because mail scanners open links. A POST, the one RFC 8058 clients send, unsubscribes. In a test mail the POST is logged and takes nobody off a list.
- **Bounces.** A hard bounce or a spam complaint suppresses the address on every list. A full mailbox does so when a second mail bounces for it within 30 days; other soft bounces (a busy server, one slow to trust a new sender) do not. Only the mail's own recipient is suppressed, never other addresses a bounce report names.
- **Sign-ups.** Browser forms are allowed by exact origin (CORS), server routes by a per-form key, sites on Cloudflare over a service binding. Each list's consent id must match the config, a honeypot field catches form bots, and requests are rate-limited per client (per /64 for IPv6). The answer is the same for a new, known or suppressed address. Without double opt-in, a sign-up never lifts a suppression and never changes an existing contact. A site over a service binding has the same rate limit.
- **Assistants (MCP).** OAuth 2.1 with PKCE S256 only, tokens bound to the `/mcp` resource, rotating refresh tokens, revocation per client and per person, and least-privilege scopes (`stats.read`, `subscribers.read`, `drafts.write`, `test.send`, `lists.write`). Sending to a list is never a scope: an admin approves each send on a page that shows the list, the subject, the count, the text part, every link and anything hidden; the approval works once, within 24 hours by default. With `approval.notifyFrom` set, the admins get the approval link by mail and the assistant never holds it. An assistant can add addresses to a list it made, and no tool returns one. Every tool call is audited. Tokens, codes and secrets are stored only as hashes.
- **Members and admins.** Sign-in for the dashboard, the consent page and approvals goes through Cloudflare Access; Utskick checks the Access JWT itself. `members` (addresses, or `@domain` for a whole company) may connect an assistant and read the dashboard; only `admins` approve sends. Every call an assistant makes checks that its person is still a member. The development stand-in works only when both the configured and the requested host are local.
- **Pages.** Every reader and admin page is server-rendered without scripts. The dashboard and approval pages carry a strict Content-Security-Policy and cannot be framed; the web archive is served in a CSP sandbox.
- **Limits on abuse.** At most one open per mail, and one click per mail and link, are logged an hour; request bodies are read only up to a small limit.
- **Local stand-ins stay local.** `SES_ENDPOINT` (the SES mock) is ignored unless the public URL is a local host, and the CLI refuses to send the admin token over plain HTTP to anything but localhost.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Privacy

- Leaving a list deletes the address from it, and the contact once it is on no list. A SHA-256 hash of the address stays on the suppression list, so an old import cannot sign the person up again; it is a pseudonym, not anonymous.
- Opens and clicks are stored as "delivery N, link M, at time T, machine or not", without IP address or user agent. Whether a machine made it is decided from the network and the user agent when the request comes in, and only the yes or no is kept. Lists without `opens` get no pixel.
- A list a colleague makes through an assistant holds addresses that colleague typed in, for one purpose the admin sees before any send. Deleting it deletes every address on no other list. In the EU, an open pixel may need consent (EDPB Guidelines 2/2023); say so where people sign up, or turn it off.
- Pages, logs, stats, the dashboard and the audit log show no address or name.
- D1 and R2 can be created in Cloudflare's EU jurisdiction, and SES runs in the AWS region you choose.

## Limits

- One SES `SendEmail` call per recipient, at up to 14 a second: about 2.5 minutes for 2,000 recipients.
- No double opt-in yet ([docs/signup.md](docs/signup.md) describes the plan). Until then, someone who left a list cannot rejoin through a form.
- Issues are HTML. Mailchimp's conditional merge tags (`*|IF:…|*`) are not supported.

## License

[GNU Affero General Public License v3.0](LICENSE). Copyright Sourceful Labs AB and contributors. If you run a modified Utskick for others, the AGPL asks you to offer them its source.
