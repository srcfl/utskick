# Sign-up forms

Utskick takes sign-ups from your own websites in three ways. All of them end in the same function, `subscribe()` in `src/contacts.ts`, so the rules below hold whichever way a site connects.

| Your site | How it connects | How Utskick knows it |
|---|---|---|
| A Cloudflare Worker or Pages project | Service binding: it calls `subscribe()` over RPC | The binding itself; the method cannot be reached from the internet |
| Any server (a Next.js route, a backend) | `POST /subscribe` with the form's key | `Authorization: Bearer <key>` |
| A page with no server of its own | `POST /subscribe` from the browser | The page's `Origin`, over CORS |

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
| 400 | `invalid_email`, `invalid_list`, `invalid_consent`, `invalid_first_name`, `invalid_country` | That field is wrong. `invalid_list` also covers a list the form may not use. |
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

Keep the route's own checks and its own limit per visitor. Utskick's rate limit sees the server's address, not the visitor's, so for a server it caps the server as a whole. [examples/sourceful-web.md](examples/sourceful-web.md) is a Next.js route that does this.

## 3. A Cloudflare Worker or Pages project, over a service binding

Bind the `utskick` Worker as a service (in a Pages project: Settings → Bindings → Service binding) and call the method:

```js
await env.UTSKICK.subscribe({ email, list: 'newsletter', consent: 'newsletter-2026-11', source: 'my-site', country: 'SE', firstName: 'Robin' });
```

The call never leaves Cloudflare, so there is no Origin, key or rate limit on Utskick's side: the calling site does those checks before it calls. It throws `invalid_list`, `invalid_email` or `invalid_consent` for a bad field and returns `{ ok: true }` otherwise. Bind it in production only, or a preview deployment signs people up for real. [examples/ftw-web.md](examples/ftw-web.md) is a Pages site that does this.

## Abuse limits

- **Size.** At most 2 KB; Utskick stops reading past that.
- **Rate.** 10 sign-ups a minute per form and client address (`CF-Connecting-IP`), with the Workers Rate Limiting binding `SIGNUP_LIMITER` in `cloudflare.config.ts`. That binding counts per Cloudflare location and is meant to be cheap rather than exact, so a few more can get through. Without the binding, as in the tests, a counter in memory takes its place. Requests refused for their origin, key, size, type, body or redirect do not count; everything after those checks does, valid or not.
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
