# Setting up an installation

Every step creates or changes something in AWS, Cloudflare or DNS. Run them in this order; each step makes what the next one needs. The commands use these variables; the values shown are Sourceful's own installation, as an example.

```bash
DOMAIN=news.sourceful.energy        # the sending subdomain; links and pages live here too
ZONE=sourceful.energy               # its Cloudflare DNS zone
REGION=eu-central-1                 # an SES region where your account has production access (Sourceful: Frankfurt)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

**SES production access.** A new SES region starts in the sandbox: 200 mails a day, verified recipients only. Check with `aws sesv2 get-account --region $REGION` (`ProductionAccessEnabled`). If it is `false`, request access (`aws sesv2 put-account-details --production-access-enabled --mail-type MARKETING …`) and allow a day for the answer.

**Workers Paid plan.** The Worker needs Cloudflare's Workers Paid plan. One cron run (step 4) sends up to about 700 mails, 14 a second for 50 seconds, and each mail is one outgoing request to SES. The Free plan allows 50 outgoing requests (subrequests) per run.

## 1. SES: the sending domain

Mail goes out from a subdomain, so a problem with the newsletter does not touch the reputation of the main domain, where everyday mail lives.

```bash
aws sesv2 create-email-identity --region $REGION --email-identity $DOMAIN
```

The answer holds three DKIM tokens. Add one CNAME per token, DNS only (not proxied):

```bash
for t in <token1> <token2> <token3>; do
  cf dns records create -z $ZONE --body "{\"type\":\"CNAME\",\"name\":\"$t._domainkey.$DOMAIN\",\"content\":\"$t.dkim.amazonses.com\",\"proxied\":false,\"ttl\":1}"
done
```

A custom MAIL FROM domain, so that SPF aligns with the From domain, and a DMARC record for the subdomain:

```bash
aws sesv2 put-email-identity-mail-from-attributes --region $REGION --email-identity $DOMAIN \
  --mail-from-domain bounce.$DOMAIN --behavior-on-mx-failure USE_DEFAULT_VALUE
cf dns records create -z $ZONE --body "{\"type\":\"MX\",\"name\":\"bounce.$DOMAIN\",\"content\":\"feedback-smtp.$REGION.amazonses.com\",\"priority\":10,\"ttl\":1}"
cf dns records create -z $ZONE --body "{\"type\":\"TXT\",\"name\":\"bounce.$DOMAIN\",\"content\":\"v=spf1 include:amazonses.com ~all\",\"ttl\":1}"
cf dns records create -z $ZONE --body "{\"type\":\"TXT\",\"name\":\"_dmarc.$DOMAIN\",\"content\":\"v=DMARC1; p=none; rua=mailto:<your DMARC report address>\",\"ttl\":1}"
```

Move DMARC to `p=quarantine` once a few issues have gone out clean.

Check: `aws sesv2 get-email-identity --region $REGION --email-identity $DOMAIN` shows `VerifiedForSendingStatus: true` and `MailFromDomainStatus: SUCCESS`. DKIM usually verifies within an hour.

## 2. SES: bounces and complaints to the Worker

```bash
aws sns create-topic --region $REGION --name utskick-events --attributes SignatureVersion=2
aws sesv2 create-configuration-set --region $REGION --configuration-set-name utskick
aws sesv2 create-configuration-set-event-destination --region $REGION \
  --configuration-set-name utskick --event-destination-name to-worker \
  --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"BOUNCE\",\"COMPLAINT\",\"DELIVERY\"],\"SnsDestination\":{\"TopicArn\":\"arn:aws:sns:${REGION}:${ACCOUNT}:utskick-events\"}}"
```

SES may publish to the topic only if the topic's access policy lets it. Without this policy no bounce, complaint or delivery ever reaches `/hooks/ses`, and nothing tells you so. The conditions let only the `utskick` configuration set in your own account publish:

```bash
aws sns set-topic-attributes --region $REGION --topic-arn arn:aws:sns:${REGION}:${ACCOUNT}:utskick-events \
  --attribute-name Policy --attribute-value "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": { \"Service\": \"ses.amazonaws.com\" },
    \"Action\": \"sns:Publish\",
    \"Resource\": \"arn:aws:sns:${REGION}:${ACCOUNT}:utskick-events\",
    \"Condition\": {
      \"StringEquals\": {
        \"AWS:SourceAccount\": \"$ACCOUNT\",
        \"AWS:SourceArn\": \"arn:aws:ses:${REGION}:${ACCOUNT}:configuration-set/utskick\"
      }
    }
  }]
}"
```

This replaces the topic's default policy; IAM users and roles in your account keep their access. Check: `aws sns get-topic-attributes --region $REGION --topic-arn arn:aws:sns:${REGION}:${ACCOUNT}:utskick-events --query Attributes.Policy` shows it.

Keep SES's account-level suppression list on (bounces and complaints), so SES refuses those addresses even if the Worker is down.

## 3. IAM: a key that can only send

```bash
aws iam create-user --user-name utskick
aws iam put-user-policy --user-name utskick --policy-name send --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": \"ses:SendEmail\",
    \"Resource\": [
      \"arn:aws:ses:${REGION}:${ACCOUNT}:identity/$DOMAIN\",
      \"arn:aws:ses:${REGION}:${ACCOUNT}:configuration-set/utskick\"
    ]
  }]
}"
aws iam create-access-key --user-name utskick
```

The key goes straight into the Worker's secrets (step 4) and nowhere else.

## 4. Cloudflare: database, bucket, Worker

```bash
cf d1 create --name utskick-db --jurisdiction eu
cf r2 buckets create --name utskick-images --cf-r2-jurisdiction eu
```

Copy `config/example.json` to `config/<you>.json` and fill in its `deploy` section: `publicUrl` (`https://$DOMAIN`; the deploy attaches that hostname to the Worker), `awsRegion`, `sesConfigurationSet`, the D1 name and id, the R2 bucket, `signupLimiterNamespace` and `statusLimiterNamespace` (any numbers no other rate limiter in the account uses). Fill in the rest too: organization, lists (with a `consent` id for lists that take form sign-ups), `forms`, `status.lists` (lists `POST /subscribe/status` may query; omit the block to leave that call off), `members` (who may use the dashboard and connect an assistant: addresses, or `"@example.com"` for everyone at a domain), `admins` (members who may also approve a send to a list) and `testAllowlist` (addresses besides the signed-in person's own that an assistant's test send may reach). Then:

```bash
cf d1 migrations apply <d1-id>
openssl rand -hex 32   # the admin token: into the secrets file, and into .env as MAILER_ADMIN_TOKEN
openssl rand -hex 32   # STATUS_KEY: into the secrets file and Bitwarden; never a form key (docs/signup.md)
```

Secrets file (`.secrets.json`, git-ignored, deleted after use):

```json
{ "ADMIN_TOKEN": "…", "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…", "SNS_TOPIC_ARN": "arn:aws:sns:<region>:<account>:utskick-events", "FORM_KEYS": "{}", "STATUS_KEY": "…" }
```

`FORM_KEYS` holds the keys of website forms that post from a server; `{}` until you have one ([signup.md](signup.md)). `STATUS_KEY` is a separate secret for `POST /subscribe/status` (whether the signed-in person is on a list). Generate it with `openssl rand -hex 32` and store it in Bitwarden as `STATUS_KEY`; it must not be a form key. Without `status.lists` in the config the call stays off.

```bash
UTSKICK_CONFIG=config/<you>.json cf deploy --secrets-file .secrets.json && rm .secrets.json
```

The deploy also adds a cron trigger that runs every minute: it sends what a person approved through an assistant, and clears out expired sign-in state. It does nothing when nothing is approved.

Apply every migration in `migrations/` (`cf d1 migrations apply <d1-id>` applies the ones not yet applied), also after an update. Some migrations rebuild a table (0003 rebuilds `contacts` so that no id is ever reused); D1's Time Travel can restore the database to any minute of the last 30 days if one goes wrong, so note the time before you apply.

## 4b. Cloudflare Access: who may sign in

The dashboard, the page where an assistant is connected, and the page where a send is approved need a person to sign in. Utskick has no passwords of its own; it trusts Cloudflare Access and checks the Access token itself.

1. Cloudflare Zero Trust → Access → Applications → add a self-hosted application for `$DOMAIN` with the paths `oauth/authorize`, `approve/*`, `dashboard` and `dashboard/*`.
2. Give it a policy that allows everyone in `members`, admins included: an "Emails ending in" rule for each `@domain` entry and an "Emails" rule for each single address (with Google as the identity provider, or Cloudflare's one-time PIN by email). Keep `approve/*` in this same application. Utskick accepts the AUD tag of one application only, and it checks itself that whoever approves a send is in `admins`.
3. Copy the application's AUD tag into `access.audience` and the team domain (`<team>.cloudflareaccess.com`) into `access.teamDomain` in your config, and deploy again.

Until this is done, those pages answer that sign-in is not set up; nothing else depends on it.

**When someone leaves**, take them out of Access (or close their account with the identity provider), so they cannot sign in again, and end their assistants' grants at once, with the admin token from `.env`:

```bash
curl -H "Authorization: Bearer $MAILER_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"subject": "name@example.com"}' https://$DOMAIN/admin/oauth/revoke
```

Utskick also checks on every call that a token's owner is still a member, so taking a single address out of `members` and deploying refuses their tokens too. An `@domain` entry still matches someone who left, so do not skip the revoke.

## 5. SNS to the Worker

```bash
aws sns subscribe --region $REGION --topic-arn arn:aws:sns:${REGION}:${ACCOUNT}:utskick-events \
  --protocol https --notification-endpoint https://$DOMAIN/hooks/ses
```

The Worker checks the signature and confirms the subscription itself. `aws sns list-subscriptions-by-topic …` then shows a subscription ARN instead of `PendingConfirmation`. If it stays pending, look for a challenge on `/hooks/ses` under Security → Events in the zone (step 7).

## 6. Prove it before the first issue

Set `MAILER_URL=https://<DOMAIN>` in `.env`.

1. **Test mail:** `node cli/utskick.ts send issue.html --list <list> --key <key> --subject "…" --test you@example.com --fname You`. In Gmail, "Show original" should say SPF, DKIM and DMARC PASS.
2. **One-click unsubscribe:** Gmail's "Unsubscribe" next to the sender POSTs to `/u/<token>`; for a test mail the POST is logged (`stats` shows it under unsubscribed) and changes nothing. Gmail may need a few sends before it shows the button; the footer link works from the first mail.
3. **Bounce and complaint (must pass before any send to a list):** `--test bounce@simulator.amazonses.com`, then `--test complaint@simulator.amazonses.com`. The CLI prints each test's key (`test <key>-test-… to 1 address(es)`). Within a minute `node cli/utskick.ts stats <that key>` shows `bounced 1` for the first and `complaints 1` for the second, and both addresses are suppressed: a second `--test` to either goes `to 0 address(es)`. If the counts stay at 0, events do not reach the Worker; check the topic policy (step 2) and the subscription (step 5). Until this passes, real bounces and complaints go unseen and those addresses stay on the list.
4. **Clicks:** click a few links in the test mail, then `node cli/utskick.ts stats <key>-test-…`.
5. **The list:** import the Mailchimp export, then `--dry-run` with the issue. The count should match Mailchimp's subscribed count. Read each `warning:` line it prints: a merge tag Utskick does not fill, a missing `*|UNSUB|*` link, or a mail too large for Gmail.

## 7. Before the first live send

Go through every line before the first `--confirm`.

- **SES:** `aws sesv2 get-account --region $REGION` shows `ProductionAccessEnabled` and `SendingEnabled` both `true`, `SendQuota.Max24HourSend` at least the list's size, and `SendQuota.MaxSendRate` at least 14.
- **SNS:** the topic policy from step 2 is in place (`aws sns get-topic-attributes …`), and the subscription from step 5 shows an ARN, not `PendingConfirmation`.
- **Simulator:** the bounce and complaint test (step 6.3) passed: `stats` shows both, and both addresses are suppressed. No live send before this.
- **Your own test mail:** Gmail's "Show original" says SPF, DKIM and DMARC PASS.
- **Unsubscribe:** Gmail's "Unsubscribe" button on a test mail shows in `stats` under unsubscribed.
- **Zone security:** nothing in the zone may challenge `POST /hooks/ses` (SNS) or `POST /u/*` (mail providers' one-click unsubscribe); neither can answer a challenge. Check Bot Fight Mode, the WAF (managed, custom and rate-limiting rules) and Browser Integrity Check, and look for those paths under Security → Events. Bot Fight Mode cannot be skipped for a path: turn it off, or on Pro and up use Super Bot Fight Mode with a skip rule. A custom rule with the Skip action covers the WAF and Browser Integrity Check.
- **workers.dev:** turn off the Worker's `workers.dev` route (Workers & Pages → the Worker → Settings → Domains & Routes), so it answers only on `$DOMAIN`, behind the zone's security and Access.
- **D1:** `cf d1 migrations list <d1-id>` lists no migration left to apply.
- **Mailchimp:** stop every Mailchimp send to the audience (campaigns, automations, RSS), then take a fresh export right before the import, so nobody who left in Mailchimp gets the issue.
- **Dry run:** the count matches Mailchimp's subscribed count, or you know why not (the import's "left out" count), and you have read every `warning:` line.
- **If the send stops:** run `node cli/utskick.ts resume <key>` with the same key. Never start it again under a new key: a new key mails everyone again.
- **Resends:** at most one per issue.
- **Gmail:** register `$DOMAIN` in Google Postmaster Tools and watch the spam rate. Keep it under 0.3%, Gmail's limit; under 0.1% is the aim.
