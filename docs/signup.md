# Sign-up forms

Utskick takes sign-ups from your own websites in three ways. All of them end in the same function, `subscribe()` in `src/contacts.ts`, so the rules below hold whichever way a site connects.

| Your site | How it connects | How Utskick knows it |
|---|---|---|
| A Cloudflare Worker or Pages project | Service binding: it calls `subscribe()` over RPC | The binding itself; the method cannot be reached from the internet |
| Any server (a Next.js route, a backend) | `POST /subscribe` with the form's key | `Authorization: Bearer <key>` |
| A page with no server of its own | `POST /subscribe` from the browser | The page's `Origin`, over CORS |
| Your own account page (server only) | `POST /subscribe/status` with `STATUS_KEY` | `Authorization: Bearer <STATUS_KEY>` — never a form key |

Pick the first that fits. A browser form is the weakest: browsers send a true `Origin`, which stops other websites from posting through their visitors, but a script can send any `Origin` it likes. For a browser form, the rate limit, the hidden bot field and the consent check do the real work.

## What a sign-up does

- The address goes on the list with the consent id, the time and the form's name as its source (`subscriptions.source`).
- An address that is suppressed, for this list (someone who left) or for every list (a hard bounce, a spam complaint, or cleaned in Mailchimp), stays out; the sign-up is dropped. Without double opt-in a form cannot tell the person from someone typing their address, so someone who left and wants back writes to you until double opt-in exists.
- The answer is the same in every case, so a form cannot be used to find out who is on a list.
- A known reader keeps their first name and country, and an existing subscription keeps its consent id, time and source. Without double opt-in, anyone can type someone else's address into a form, and must not be able to change what that person agreed to.

## `POST /subscribe`

The body is `application/json` or `application/x-www-form-urlencoded`, at most 2 KB.

| Field | | |
|---|---|---|
| `email` | required | The address. Case and spaces at the ends do not matter. |
| `list` | required | A list id from the config that this form may use. |
| `consent` | required | The list's current consent id from the config. Any other value is refused, so a form cannot record a consent text you never showed. |
| `first_name` | optional | Letters, spaces, hyphens and apostrophes, at most 40 characters, since it goes into the greeting of every mail. Anything else is dropped and the sign-up still counts. |
| `country` | optional | Two letters, such as `SE`. |
| `website` | leave empty | A hidden field for bots. When it is filled, the answer is the usual success and nothing is stored. |
| `redirect` | optional | For a plain HTML form: the page to send the browser to afterwards. It must be on one of the form's `origins`. |

Answers:

- `200 {"ok": true}`: signed up, already on the list, kept out after a bounce or complaint, or caught by the bot field. Utskick does not say which.
- With `redirect`: `303` to that page. When the request is refused after the redirect has been checked, the browser goes to the same page with `?error=<code>` added.
- Otherwise a small JSON error, `{"error": "<code>"}`, and nothing is stored:

| Status | `error` | Why |
|---|---|---|
| 400 | `invalid_email`, `invalid_list`, `invalid_consent` | That field is wrong. `invalid_list` also covers a list the form may not use. A first name or country that is not one is dropped, not refused. |
| 400 | `invalid_body`, `invalid_redirect` | Not a JSON object; a thank-you page that is not on the form's origins. |
| 401 | `key_required`, `invalid_key` | No key, or not a form's key. A browser posting from the page of a form that needs a key gets `key_required`. |
| 403 | `origin_not_allowed` | The `Origin` is on no form's list. `null` never is. |
| 405 | `method_not_allowed` | Only `POST`, and `OPTIONS` for the preflight. |
| 413 | `too_large` | The body is over 2 KB. |
| 415 | `unsupported_media_type` | Not JSON or URL-encoded. `multipart/form-data` is not taken. |
| 429 | `rate_limited` | Too many sign-ups from this client; `Retry-After` says when to try again. |
| 503 | `signup_unavailable` | `FORM_KEYS` is not valid JSON. |

Every answer carries `Vary: Origin`. `Access-Control-Allow-Origin` names the request's own origin, and only when that origin is on the form's list. A preflight (`OPTIONS`) is answered only for the origins of forms that do not need a key: `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Content-Type`. Browsers are never allowed to send `Authorization`.

## Config

Each list that takes form sign-ups names its current consent id. Each form names its lists, its origins and whether it needs a key. The form's name is stored as the source of its sign-ups, so use lowercase letters, digits and hyphens, at most 40.

```json
{
  "lists": {
    "newsletter": { "name": "The Example Newsletter", "from": "Example Co <newsletter@news.example.com>", "consent": "newsletter-2026-11" }
  },
  "forms": {
    "example-web": { "lists": ["newsletter"], "origins": ["https://example.com", "https://www.example.com"] },
    "example-app": { "lists": ["newsletter"], "key": true }
  }
}
```

- An origin is a scheme, host and port, as the browser sends it: `https://example.com`, no path and no trailing slash. The match is exact, so list `www.` and the bare domain both if you serve both.
- An origin belongs to one browser form. If two forms list it, the first wins.
- A list without `consent` takes no form sign-ups. RPC callers are not checked against it: they record their own consent id.
- A form with `key: true` is posted by its server. Its `origins` are optional: they say where a thank-you redirect may go, and a request that carries an `Origin` must match them.

### Form keys

Keys live in one Worker secret, `FORM_KEYS`, a JSON object from form name to key. Each key is at least 32 characters; a shorter one is ignored. Utskick compares them in constant time and never logs them.

```bash
openssl rand -hex 32                       # one key per form
```

```json
{ "FORM_KEYS": "{\"example-app\":\"<64 hex characters>\"}" }
```

Put that line in the secrets file and deploy with it (`cf deploy --secrets-file .secrets.json && rm .secrets.json`, as in [setup.md](setup.md)). `cloudflare.config.ts` declares `FORM_KEYS` as a required secret, like the others, so expect a deploy without it to be refused; set it to `{}` when no form needs a key. Afterwards `cf workers secrets list --worker utskick` should show it next to the other secrets.

To change a key, set the new one in `FORM_KEYS` and on the calling server at about the same time. Sign-ups in between get `invalid_key`.

## 1. A browser form, over CORS

With `fetch` and JSON. The browser sends a preflight first, which Utskick answers for the form's origins:

```html
<form id="signup">
  <input type="email" name="email" required>
  <label><input type="checkbox" name="consent" value="newsletter-2026-11" required> Send me the newsletter. <a href="/privacy">How we use your address</a></label>
  <div aria-hidden="true" style="position:absolute; left:-10000px"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
  <button>Sign up</button>
</form>
<script>
  document.getElementById('signup').addEventListener('submit', async event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.target));
    const res = await fetch('https://news.example.com/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, list: 'newsletter' }),
    });
    const { error } = await res.json();
    // show "Thanks" when !error, or a message per error code
  });
</script>
```

A plain HTML form works without JavaScript. It posts URL-encoded fields, which needs no preflight, and `redirect` sends the browser on afterwards:

```html
<form method="post" action="https://news.example.com/subscribe">
  <input type="email" name="email" required>
  <input type="hidden" name="list" value="newsletter">
  <input type="hidden" name="redirect" value="https://example.com/thanks">
  <label><input type="checkbox" name="consent" value="newsletter-2026-11" required> Send me the newsletter.</label>
  <div aria-hidden="true" style="position:absolute; left:-10000px"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
  <button>Sign up</button>
</form>
```

`/thanks` then reads `?error=` when there is one. On a page with `Referrer-Policy: no-referrer` or `same-origin`, the browser sends `Origin: null` with a plain form post to another site, and Utskick refuses it. The default, `strict-origin-when-cross-origin`, works.

## 2. A server route, with a form key

The server keeps the key in its own environment and never sends it to the browser.

```bash
curl https://news.example.com/subscribe \
  -H "Authorization: Bearer $FORM_KEY" -H 'Content-Type: application/json' \
  -d '{"email": "reader@example.com", "list": "newsletter", "consent": "newsletter-2026-11"}'
```

Keep the route's own checks and its own limit per visitor. Utskick's rate limit sees the server's address, not the visitor's, so for a server it caps the server as a whole: 10 sign-ups a minute. Pass the visitor's address in `X-Client-IP` and the limit counts per visitor instead; the form's key vouches for the header, so Utskick reads it only from a form with a key.

A server form can also take someone off one of its lists, as when a reader turns the newsletter off in an app:

```bash
curl https://news.example.com/unsubscribe \
  -H "Authorization: Bearer $FORM_KEY" -H 'Content-Type: application/json' \
  -d '{"email": "reader@example.com", "list": "newsletter"}'
```

It answers `200 {"ok": true}` whether or not the address was on the list, and the same errors as `/subscribe`. The address is suppressed for that list, so the form cannot sign it up again; the reader joins again by writing to you. Only a form with a key can do this, never a browser form. Whether someone is on a list is a separate call, `POST /subscribe/status`, with its own secret.

## 3. A Cloudflare Worker or Pages project, over a service binding

Bind the `utskick` Worker as a service (in a Pages project: Settings → Bindings → Service binding) and call the method:

```js
await env.UTSKICK.subscribe({ email, list: 'newsletter', consent: 'newsletter-2026-11', source: 'my-site', country: 'SE', firstName: 'Robin',
  ip: request.headers.get('CF-Connecting-IP') });
```

The call never leaves Cloudflare, so there is no Origin or key on Utskick's side: the calling site checks those before it calls. The rate limit holds, though, since the site's own form is open to anyone: 10 sign-ups a minute per visitor when the site passes the visitor's address as `ip`, and 10 a minute for the whole site when it does not. It throws `rate_limited`, `invalid_list`, `invalid_email` or `invalid_consent`, and returns `{ ok: true }` otherwise. Bind it in production only, or a preview deployment signs people up for real. [examples/ftw-web.md](examples/ftw-web.md) is a Pages site that does this.

## 4. Is this person on a list? `POST /subscribe/status`

A signed-in account page may need to know whether *that person* is on a list, for example `app-users`. That is personal data: the call exists only for a server you control, authenticated with a secret that never goes to a browser, an app binary, or a form.

**Never use a form key here.** Form keys are for `POST /subscribe` and `POST /unsubscribe`. They are held by websites and apps, so treat them as public. A leaked form key that answered "is this address on the list?" would let anyone check who subscribes. Utskick refuses a form key on this path with `401 {"error": "form_key_not_allowed"}`, even if you accidentally set `STATUS_KEY` to the same value.

The caller is responsible for passing only the signed-in person's own address, one per request.

```bash
curl https://news.example.com/subscribe/status \
  -H "Authorization: Bearer $STATUS_KEY" -H 'Content-Type: application/json' \
  -d '{"email": "reader@example.com", "list": "newsletter"}'
```

`STATUS_KEY` is a Worker secret. Generate it with `openssl rand -hex 32` and store it in Bitwarden under that name, next to `ADMIN_TOKEN` and `FORM_KEYS`. It must be at least 32 characters and a different value from every form key. On the calling server (for Sourceful: the Vercel web-app), keep the same value under a name that cannot be confused with a form key, for example `UTSKICK_STATUS_KEY`. Do not put it in `FORM_KEYS`.

The body is `application/json` only, at most 2 KB, one object:

| Field | | |
|---|---|---|
| `email` | required | The address. Case and spaces at the ends do not matter. One address only: an `emails` array is ignored, and `email` as an array is refused. |
| `list` | required | A list id from `status.lists` in the config. |

Answers:

- `200 {"subscribed": true}` or `200 {"subscribed": false}`. Nothing else: no address, name, consent, source or suppression reason. `false` covers never signed up, left, and bounced. `Cache-Control: no-store`.
- No CORS. This is server-to-server; a browser must not call it.

| Status | `error` | Why |
|---|---|---|
| 400 | `invalid_email`, `invalid_list`, `invalid_body` | That field is wrong, or `list` is not in `status.lists`. |
| 401 | `key_required`, `invalid_key`, `form_key_not_allowed` | No key, not `STATUS_KEY`, or a form key. |
| 405 | `method_not_allowed` | Only `POST`. A GET would put the address in the URL, which logs keep. |
| 413 | `too_large` | The body is over 2 KB. |
| 415 | `unsupported_media_type` | Not JSON. |
| 429 | `rate_limited` | Too many lookups from this client; `Retry-After` says when to try again. |
| 503 | `status_unavailable` | `STATUS_KEY` is missing or too short, or `status.lists` is empty. |

Config: name the lists this secret may query. With no `status` block, or an empty list, the endpoint is off.

```json
{
  "status": { "lists": ["newsletter"] }
}
```

Sourceful's web-app asks about `app-users` only.

Logs: `{ event: "subscription_status", list, subscribed }` on a 200, and `{ event: "form_key_rejected", path: "/subscribe/status" }` when a form key is presented. No address, no key.

## Abuse limits

- **Size.** At most 2 KB; Utskick stops reading past that.
- **Rate.** 10 sign-ups a minute per form and client address (`CF-Connecting-IP`, or `X-Client-IP` from a form with a key; `ip` over a service binding), with the Workers Rate Limiting binding `SIGNUP_LIMITER` in `cloudflare.config.ts`. That binding counts per Cloudflare location and is meant to be cheap rather than exact, so a few more can get through. Without the binding, as in the tests, a counter in memory takes its place. Requests refused for their origin, key, size, type, body or redirect do not count; everything after those checks does, valid or not. `POST /subscribe/status` has its own limiter, `STATUS_LIMITER`: 120 lookups a minute per calling server (`CF-Connecting-IP` only; `X-Client-IP` is ignored, so a stolen `STATUS_KEY` cannot mint a new budget per guessed address).
- **Bots.** The hidden `website` field: a bot that fills it gets the usual answer and nothing is stored.
- **Consent.** Only the list's current consent id is accepted.
- **No redirect elsewhere.** `redirect` must be on the form's own origins, compared as parsed URLs, so `https://example.com.evil.example/` and `javascript:` are refused.
- **Nothing to learn.** The same answer for a new, a known and a suppressed address.
- **Logs.** No address, no key, and not the parser's message when `FORM_KEYS` is broken, since that message quotes the secret.

## Changing the consent text

The consent id names the text a reader agreed to: the words by the form and the privacy notice they link to. When either changes, give the list a new id (for example `newsletter-2027-03`) and change the form to send it. Utskick accepts only one id per list, so deploy the two close together: a sign-up sent with the old id in between gets `invalid_consent`. Each sign-up keeps the id it was made with, so you can later show which text each reader saw.

## Next: double opt-in

Version 1 signs an address up at once. Anyone can type someone else's address into a form, and that person then gets mail they never asked for. Some will mark it as spam, which harms the sending domain's standing with Gmail and others, and a sign-up alone does not prove that the owner of the address agreed. A confirmation mail fixes both: only the owner can click the link in it.

How it would fit:

1. `/subscribe` keeps every check above, but instead of calling `subscribe()` it stores a pending sign-up: address, list, consent id, source, time, and the SHA-256 of a random 128-bit token that expires after about 48 hours. It sends one plain mail through SES, with no marketing in it, that links to `/confirm/<token>`. The answer stays the same as now.
2. `GET /confirm/<token>` only shows a button, because mail scanners open links, as for unsubscribing. The `POST` signs the address up and deletes the pending row together, so the token works once.
3. The cron that already runs every minute deletes expired pending rows. A pending row is on no list, is never counted, and gets no other mail.
4. At most one confirmation mail per address a day, so the form cannot be used to flood someone's inbox.
5. The consent time is when the reader clicked, and the source and consent id are the ones from the form.

It needs one new table in a new migration, and a confirmation template in the config per list.
