# Setting up an installation

Every step creates or changes something in AWS, Cloudflare or DNS. Run them in this order; each step makes what the next one needs. The commands use these variables; the values shown are Sourceful's own installation, as an example.

```bash
DOMAIN=news.sourceful.energy        # the sending subdomain; links and pages live here too
ZONE=sourceful.energy               # its Cloudflare DNS zone
REGION=eu-central-1                 # an SES region where your account has production access (Sourceful: Frankfurt)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

**SES production access.** A new SES region starts in the sandbox: 200 mails a day, verified recipients only. Check with `aws sesv2 get-account --region $REGION` (`ProductionAccessEnabled`). If it is `false`, request access (`aws sesv2 put-account-details --production-access-enabled --mail-type MARKETING …`) and allow a day for the answer.

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
  --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"BOUNCE\",\"COMPLAINT\",\"DELIVERY\"],\"SnsDestination\":{\"TopicArn\":\"arn:aws:sns:$REGION:$ACCOUNT:utskick-events\"}}"
```

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
      \"arn:aws:ses:$REGION:$ACCOUNT:identity/$DOMAIN\",
      \"arn:aws:ses:$REGION:$ACCOUNT:configuration-set/utskick\"
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

Copy `config/example.json` to `config/<you>.json` and fill in its `deploy` section: `publicUrl` (`https://$DOMAIN`; the deploy attaches that hostname to the Worker), `awsRegion`, `sesConfigurationSet`, the D1 name and id, the R2 bucket, and `signupLimiterNamespace` (any number no other rate limiter in the account uses). Fill in the rest too: organization, lists (with a `consent` id for lists that take form sign-ups), `forms`, `admins` (who may use the dashboard, connect assistants and approve sends) and `testAllowlist` (the only addresses an assistant's test send may reach). Then:

```bash
cf d1 migrations apply <d1-id>
openssl rand -hex 32   # the admin token: into the secrets file, and into .env as MAILER_ADMIN_TOKEN
```

Secrets file (`.secrets.json`, git-ignored, deleted after use):

```json
{ "ADMIN_TOKEN": "…", "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…", "SNS_TOPIC_ARN": "arn:aws:sns:<region>:<account>:utskick-events", "FORM_KEYS": "{}" }
```

`FORM_KEYS` holds the keys of website forms that post from a server; `{}` until you have one ([signup.md](signup.md)).

```bash
UTSKICK_CONFIG=config/<you>.json cf deploy --secrets-file .secrets.json && rm .secrets.json
```

The deploy also adds a cron trigger that runs every minute: it sends what a person approved through an assistant, and clears out expired sign-in state. It does nothing when nothing is approved.

Apply every migration in `migrations/` (`cf d1 migrations apply <d1-id>` applies the ones not yet applied), also after an update. Some migrations rebuild a table (0003 rebuilds `contacts` so that no id is ever reused); D1's Time Travel can restore the database to any minute of the last 30 days if one goes wrong, so note the time before you apply.

## 4b. Cloudflare Access: who may sign in

The dashboard, the page where an assistant is connected, and the page where a send is approved need a person to sign in. Utskick has no passwords of its own; it trusts Cloudflare Access and checks the Access token itself.

1. Cloudflare Zero Trust → Access → Applications → add a self-hosted application for `$DOMAIN` with the paths `oauth/authorize`, `approve`, `dashboard` and `dashboard/*`.
2. Give it a policy that allows exactly the addresses in `admins` (with Google as the identity provider, or Cloudflare's one-time PIN by email).
3. Copy the application's AUD tag into `access.audience` and the team domain (`<team>.cloudflareaccess.com`) into `access.teamDomain` in your config, and deploy again.

Until this is done, those pages answer that sign-in is not set up; nothing else depends on it.

## 5. SNS to the Worker

```bash
aws sns subscribe --region $REGION --topic-arn arn:aws:sns:$REGION:$ACCOUNT:utskick-events \
  --protocol https --notification-endpoint https://$DOMAIN/hooks/ses
```

The Worker checks the signature and confirms the subscription itself. `aws sns list-subscriptions-by-topic …` then shows a subscription ARN instead of `PendingConfirmation`.

## 6. Prove it before the first issue

Set `MAILER_URL=https://<DOMAIN>` in `.env`.

1. **Test mail:** `node cli/utskick.ts send issue.html --list <list> --key <key> --subject "…" --test you@example.com --fname You`. In Gmail, "Show original" should say SPF, DKIM and DMARC PASS.
2. **One-click unsubscribe:** Gmail's "Unsubscribe" next to the sender POSTs to `/u/<token>`; for a test mail the POST is logged (`stats` shows it under unsubscribed) and changes nothing. Gmail may need a few sends before it shows the button; the footer link works from the first mail.
3. **Bounce and complaint:** `--test bounce@simulator.amazonses.com`, then `--test complaint@simulator.amazonses.com`. Within a minute both addresses are on the suppression list.
4. **Clicks:** click a few links in the test mail, then `node cli/utskick.ts stats <key>-test-…`.
5. **The list:** import the Mailchimp export, then `--dry-run` with the issue. The count should match Mailchimp's subscribed count.
