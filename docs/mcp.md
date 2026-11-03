# Assistants: MCP and OAuth

Utskick has one MCP endpoint, `${PUBLIC_URL}/mcp`. Claude, ChatGPT, Grok, other assistants, Cursor, Claude Code and Codex can connect to it, for everyone in `members`, a whole company if you like. An assistant can read the numbers, write and preview drafts, send tests to the person using it, make a list of people that person names for one mailing, and ask for a send to a list. It cannot send to a list. An admin approves each such send on a page of its own.

A colleague's usual way, which the server's instructions give every assistant: make a list and add people (or pick a newsletter), write a draft with an unsubscribe link, preview it and fix its warnings, send a test to themselves, ask for the send, and read the numbers once it has gone out.

The server follows the MCP authorization spec, revision 2026-07-28, as [srcfl/ftw-cloud](https://github.com/srcfl/ftw-cloud) does. The code is in `src/oauth.ts`, `src/clients.ts`, `src/identity.ts`, `src/mcp.ts`, `src/tools.ts`, `src/drafts.ts` and `src/approvals.ts`; the tables are in `migrations/0002_oauth.sql` and `migrations/0004_auth.sql`.

## Connecting a client

Every client needs only the URL. It finds the rest itself: a request without a token gets a 401 whose `WWW-Authenticate` header points at `/.well-known/oauth-protected-resource/mcp`, which names the authorization server, whose metadata is at `/.well-known/oauth-authorization-server`. The client then sends the person's browser to `/oauth/authorize`. They sign in as a member, tick what the assistant may do, and the browser returns to the client with a code.

| Client | How |
|---|---|
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → Add custom connector, with the URL. Claude names itself by a client ID metadata document. |
| ChatGPT | Settings → Apps & Connectors → Advanced → Developer mode, then Create, with the URL and OAuth. ChatGPT registers itself at `/oauth/register`. |
| Grok | Add a remote MCP server with the URL. |
| other assistants | As for Cursor below: it finishes sign-in through Cursor's callback, `cursor://anysphere.cursor-mcp/oauth/callback`, the one custom-scheme redirect Utskick takes. |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"utskick": {"url": "https://news.example.com/mcp"}}}`, then Connect in the MCP settings. |
| Claude Code | `claude mcp add --transport http utskick https://news.example.com/mcp`, then `/mcp` to sign in. |
| Codex | `~/.codex/config.toml`: `[mcp_servers.utskick]` with `url = "https://news.example.com/mcp"`, then `codex mcp login utskick`. |

A client that cannot store tokens across restarts asks the admin to sign in again; nothing else changes.

## Scopes

Each tool needs one scope. The consent page lists the scopes the client asked for, all ticked; the member unticks what the assistant should not have. A client that asks for none is offered all five.

| Scope | Tools | What it allows |
|---|---|---|
| `stats.read` | `sends_list`, `send_stats`, `deliverability` | The latest sends side by side with their rates, one send's numbers and clicks per link, people and machines apart, and sending health over 30 days. Never who got a mail, opened it or clicked. |
| `subscribers.read` | `subscriber_counts`, `list_growth` | How many are on each list, how many can be mailed, how many left, and each newsletter's growth by month. Counts only. |
| `drafts.write` | `drafts_list`, `draft_save`, `draft_preview`, `request_send`, `approval_status` | Write drafts in HTML or Markdown, preview them with the sample name Alex and no real recipient, and ask an admin to approve a send. |
| `test.send` | `test_send` | Send a draft or an earlier issue as a test (`[Test]` in the subject) to the person who connected the assistant (the default), or to the addresses in `testAllowlist` in the config, and nowhere else. At most 20 test sends an hour, for all assistants together, of up to 20 addresses each. |
| `lists.write` | `list_create`, `list_add`, `list_remove`, `list_delete` | Make a list for one mailing, add up to 500 people a call, take them off, and delete the list when the mailing is done. Addresses go in; only counts come out. Never a newsletter from the config: people join those themselves. |

Drafts are shared: every assistant with `drafts.write` can read and change every draft. Each draft records the assistant that made it and the one that changed it last; `drafts_list`, the approval page and the dashboard show both.

A call without its scope gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, naming the scopes the token has plus the one it lacks, so the client can ask the admin again. Tool listings carry `securitySchemes` with each tool's scope, as ChatGPT expects.

Not built, on purpose:

- **`subscribers.personal`**: reading who is on a list (addresses, names). Personal data, under GDPR's rules on access and purpose. If it is ever needed, it gets a scope of its own, off by default on the consent page, with its own audit entries. No tool has it today, and Utskick refuses the name as an unknown scope.
- **Sending to a list.** Never a scope. See below.

## Sending to a list: the approval

1. The assistant calls `request_send` with a draft id and, if it likes, a send key such as `the-source-23` (the key is part of the web version's address, `/a/<key>`). The default key is the list and today's date.
2. Utskick checks that the draft has an `*|UNSUB|*` link and that the key is free, counts the recipients with a dry run, and stores a copy of the draft's subject and HTML. What is approved is what goes out, whatever happens to the draft afterwards.
3. With `approval.notifyFrom` in the config, every admin gets a mail from that address with the approval link, and the assistant gets only the request's id and when it ends. Without it, the assistant gets the link, `/approve/<secret>`, and gives it to the user. Nothing has been sent. Each person may ask for 10 sends an hour, since each request mails every admin.
4. An admin opens the link and signs in. Only an admin: a member who asked cannot approve their own request. The page shows the list, the subject, the sender, the recipient count now and when the assistant asked, the key, which assistant asked for whose grant, which assistants made and last changed the draft, and the mail itself. For a list a colleague made, it shows who made it (replies go to them) and what it is for. Beside the preview it shows what a browser preview hides: the text/plain part as it goes out, every link target as text, what the mail loads, and a warning for parts only Outlook shows (`<!--[if mso]>`) and for text hidden with CSS (`display:none`, `visibility:hidden`, zero size and the like), apart from a short preheader at the top.
5. Send or Decline. The answer counts once: the request is single-use and ends `approval.hours` after the assistant asked, 24 hours unless the config says otherwise. The recipient count is taken again when the admin opens the page and when they press Send.
6. On Send, Utskick creates the send (`kind` live) as the CLI would. The cron trigger, every minute, sends approved sends 14 mails a second for at most 50 seconds and 30 batches a run, until none are left. A request approved less than two minutes ago whose send is not there yet waits for the next run; after that it fails as `no_such_send`. If SES refuses for the whole account (a bad key, sending paused, the sandbox, the day's quota), the run stops, logs SES's error type once, and the request stays approved for the next run. If SES refuses every mail of a batch the same way, the batch goes back in line once; refused the same way again, those rows stay `failed` and the send goes on, so one send cannot hold up the others. `approval_status` and `send_stats` show the progress.

Sends made with the CLI (`node cli/utskick.ts send … --confirm N`) do not pass through any of this, and the cron leaves them alone.

## Lists for one mailing

A colleague often needs to mail a few dozen people who never signed up for a newsletter: an event's guests, a group of partners. With `lists.write` an assistant makes such a list (`list_create`, with a name readers see and a purpose the approving admin reads), adds the people the user names (`list_add`), and the rest is as for any list: a draft, a test, a request, an admin's approval.

- Mail to these lists comes from `adhoc.from` in the config, and replies go to the colleague who made the list. Without an `adhoc` section, `list_create` is off.
- They live in D1 (the `lists` table), beside the config's lists. A config list with the same id wins.
- `list_add` skips addresses that bounced, complained or left that list, keeps a known contact's name, and answers with counts only. People added this way have the consent `adhoc` and the source `assistant`.
- Every mail needs an unsubscribe link, as always. Leaving one of these lists takes the reader off that list only.
- `list_delete` takes everyone off, deletes each address that is on no other list, withdraws a send that waits for approval, and keeps the list's name for the pages of sends already made.
- Only the colleague who made a list, or an admin, can add to it, take people off or delete it. Drafts stay shared.
- An id is taken for good: a list's id, deleted or not, or any id that ever had subscribers, suppressions or sends.
- These mailings have no public web version (`/a/<key>` answers 404), and the Markdown layout leaves out its link.
- The open pixel is off unless `adhoc.opens` is true.

## Security model

**Who signs in.** `src/identity.ts` has a small interface: a provider says whose browser a request comes from, and the config says what that person may do. `members` (addresses, or `"@example.com"` for everyone at a domain, not its subdomains) may connect an assistant and read the dashboard. `admins` are members who may also approve a send. Utskick keeps no accounts and no passwords.

**Leaving.** Every `/mcp` call and every refresh checks that the person behind the grant is still a member, so taking an address out of `members` and deploying ends their assistants at once. An `@domain` entry still matches someone who has left, so also take them out of Access and run `/admin/oauth/revoke` with their address (below).

- **Cloudflare Access** (the default). Access sits in front of `/oauth/authorize` and `/approve/`, signs the person in with whatever the team uses, and adds a signed JWT to each request (`Cf-Access-Jwt-Assertion`). Utskick checks that JWT itself, against the team's keys at `https://<teamDomain>/cdn-cgi/access/certs`, the issuer, the audience (`access.audience`) and the expiry, then looks the email up in `admins`. A path that slips out of the Access application therefore still lets nobody in.
- **Dev stub.** Under `cf dev`, `DEV_IDENTITY` (set in `cloudflare.config.ts` only in development mode) makes every sign-in the first admin. It works only when both `PUBLIC_URL` and the host the request reached are `localhost`, `127.0.0.1`, `[::1]` or a `.test` name. A Worker deployed in development mode by mistake has a local `PUBLIC_URL`, but a stranger reaches it on its public host, and is signed in as nobody.
- **Passkeys** (not built). A WebAuthn provider would fit the same interface without Cloudflare Access: each admin registers a passkey once (from an invite the CLI makes), Utskick stores the public key in D1, and `/oauth/authorize` and `/approve/` ask for an assertion before they act. That trades a dependency on Access for code Utskick would own: registration, recovery and a session cookie.

**OAuth.** OAuth 2.1, authorization code only, PKCE with `S256` only: a missing challenge or `plain` is refused before anything is stored. Every authorization response carries `iss` (RFC 9207). Tokens are bound to `${PUBLIC_URL}/mcp` (RFC 8707): `/oauth/authorize` and `/oauth/token` refuse any other `resource`, and `/mcp` refuses a token issued for another. Access tokens last 10 minutes. Refresh tokens rotate; a retry within 5 seconds works once and ends the tokens the first answer issued, so one chain of tokens lives on. Any later reuse revokes the whole grant, as does a retry after the first answer's refresh token was used, a use of that dead token, or a code used twice. A refresh refuses a token or grant made for another resource, such as one issued while the Worker ran under another `PUBLIC_URL`. Refresh tokens last 30 days and no grant outlives 90. Revocation follows RFC 7009 (`/oauth/revoke`); revoking a refresh token ends its grant. A grant that ends, whichever way, declines the send requests made with it that nobody has answered.

**Nothing secret is stored as itself.** Access tokens, refresh tokens, codes, client secrets, consent ids and approval links are random 256-bit values, and D1 keeps their SHA-256.

**Clients.** A client ID metadata document (an https `client_id`) is fetched only after an admin has signed in, and the fetch is fenced: https on the default port to a DNS name (no address literals, no `localhost`, `.local`, `.internal` or `.test`, no empty label or trailing dot, not Utskick's own host), no redirects, 16 KiB, 5 seconds, cached for one minute to one day. The document must name itself, list 1 to 16 redirect URIs that are https or loopback http, hold no secret and use no client authentication. Dynamic registration (RFC 7591) takes the same redirect URIs. Each client address may register 20 clients a day (an IPv6 /64 counts as one address), counted in D1 by a hash of the address that is kept for a day, and bursts go through the `SIGNUP_LIMITER` rate limiter under `register:` keys when it is bound. Registrations that never get a grant are deleted after an hour. The consent page says where the browser returns to, and warns when that is a program on the admin's own computer. Errors after the redirect URI checks out go back as a link the admin follows, never as a redirect.

**Pages.** The consent and approval pages refuse to be framed, and their forms accept a post only from Utskick's own origin. The approval page loads nothing from elsewhere: its `Content-Security-Policy` (`default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`) also binds the sandboxed preview, which inherits it, so opening the page tells the draft's writer nothing. Remote images show as missing and are listed as text.

**What an assistant sees.** No tool returns a subscriber's address. The list tools take addresses in and answer with counts. `send_stats` and `sends_list` pass through a filter that blanks anything shaped like an address. Previews use a sample name. Every result says it is data, not instructions: a draft or a subject written by someone else may try to steer a model.

**Audit.** Every tool call, refused or not, is a row in `audit_log`: time, client id, the admin whose grant it used, the scope, the tool, a summary of the arguments (keys, lists, counts, never a body; anything shaped like an address blanked) and the outcome. Approving or declining a send adds a row naming the admin who did it. Every `/admin` call that changes something (an import, a send, a batch, a retry, a revocation, an image) adds a row as client `admin-token`, with the method and path as the tool, the outcome, and counts and keys as the summary, never an address. Reads and dry runs add none, and a body that is not a JSON object gets 400.

**What is left to watch.**

- An assistant that drives a browser (computer use, a browser extension) could open an approval link in a signed-in browser and press Send. Keep such assistants away from the approval page.
- Cloudflare Access must cover `/oauth/authorize` and `/approve/`. If it does not, those pages answer "sign in again" and nobody gets in; they never fall open.
- `/mcp` has no rate limit of its own. If you need one, add a Cloudflare rate-limiting rule on it.
- A member can put any address on a list they make. The admin who approves the send sees the list's purpose and who made it, and decides whether those people expect the mail. Bought or scraped addresses bounce and draw complaints, which hurt every list's delivery: say no to those.

## Admin API

With the CLI's bearer token (`ADMIN_TOKEN`):

```bash
curl -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" https://news.example.com/admin/oauth/grants
curl -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"clientId": "utk_c_…"}' https://news.example.com/admin/oauth/revoke
curl -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"subject": "someone@example.com"}' https://news.example.com/admin/oauth/revoke
curl -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" 'https://news.example.com/admin/audit?limit=100'
```

Revoking a client deletes its grants, tokens and open consents, and its registration if it registered here. It must sign in again, and a member must approve it again. Revoking a person (`subject`) ends every grant they gave, and the sends those assistants asked for that nobody has answered.

## Setting it up

Each step changes something in Cloudflare, so each needs the owner's go-ahead, as in `docs/setup.md`.

1. Apply the migrations: `cf d1 migrations apply <d1-id>` (locally: `npm run db:local`).
2. Cloudflare Zero Trust → Access → Applications → Add a self-hosted application for your Utskick host with the paths `oauth/authorize`, `approve/*`, `dashboard` and `dashboard/*`, and a policy that allows everyone in `members` (admins included). Utskick itself checks that whoever approves a send is an admin. Copy the application's AUD tag into `access.audience` in your config file, and the team domain (`<team>.cloudflareaccess.com`) into `access.teamDomain`.
3. Keep everything else public: `/mcp`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` and `/.well-known/` are called by the assistants' servers, and `/u/`, `/c/`, `/o/`, `/a/`, `/img/` and `/hooks/ses` by readers and SES.
4. Set `members`, `admins` and `testAllowlist` in the config, and `adhoc` and `approval` if you want lists for one mailing and approval links by mail. The Access policy must let in everyone in `members`.
5. Deploy. The deploy adds the cron trigger.
6. Connect one client, call `subscriber_counts`, then send a draft to yourself with `test_send`.

Locally, `npm run dev` runs it all with the dev identity and the SES mock. Point the MCP inspector at it: `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `http://localhost:5173/mcp`.
