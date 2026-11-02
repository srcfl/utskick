# Example: a Cloudflare Pages site's sign-up form over a service binding

How the sign-up form of [FTW's website](https://github.com/srcfl/ftw-web) (Cloudflare Pages, a `_worker.js`) hands sign-ups to Utskick. The diff is in [ftw-web.patch](ftw-web.patch), against `srcfl/ftw-web` at `89bf819`; the site's tests pass with it. The same pattern fits any Worker or Pages site in the same Cloudflare account.

## What changes

- **`_worker.js`**: `/api/signup` keeps all its checks (same origin, JSON only, address, list, country, the hidden bot field, the same answer for new and known addresses). Instead of writing to its own D1, it calls `env.UTSKICK.subscribe({ email, list, country, consent, source: 'ftw-web' })`, with the site's `news` and `gateway` mapped to Utskick's `ftw-news` and `ftw-box`. `UTSKICK` is a service binding to the `utskick` Worker. `subscribe()` is an RPC method on the Worker's entrypoint, so it cannot be reached from the internet, and the call never leaves Cloudflare.
- **`signups.sql`**: removed. Utskick owns the schema (`migrations/0001_init.sql`).
- **`tests/signups.test.mjs`**: the fixture fakes the binding instead of D1. Deduplication and re-sign-up now live in Utskick and are tested there (`test/subscribe.test.ts`).
- **`README.md`**: the sign-up section describes the binding, and says to bind it in production only (today production and preview share `ftw-signups`; a preview with `UTSKICK` would sign people up for real).
- **`privacy.html#email`**: names the sending service and region, as the page promised before the first mail: Utskick, delivering through Amazon SES in Amazon Web Services' Frankfurt region; the address kept as a one-way hash after leaving so we do not mail it again; click counting without device data or IP address; no open tracking in FTW mail; bounces and spam reports stop mail to that address. The date moves to the day it ships.

Why a service binding rather than binding Utskick's D1 into the site: the site then needs to know nothing about Utskick's tables, and Utskick can change them without breaking the form.

## Order on the day

1. Utskick is deployed and has sent a test mail ([docs/setup.md](../setup.md)).
2. Add the service binding in the Pages project (Settings → Bindings → Service binding: `UTSKICK` → `utskick`, production only), then deploy the site change.
3. If the site kept sign-ups of its own before, move them with their original time and consent through `/admin/import` (`contacts: [{ "email": "…", "consentedAt": "<the time they signed up>" }]`), then delete the site's own copy, so each address is held in one place only.
