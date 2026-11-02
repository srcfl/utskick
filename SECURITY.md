# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- on GitHub: **Security → Report a vulnerability** in this repository, or
- by email to support@sourceful.energy, with "Utskick security" in the subject.

We answer within five working days, tell you what we will do, and credit you in the fix unless you ask us not to. Only the latest `main` is supported.

## In scope

The Worker (`src/`), the CLI (`cli/`), the database schema (`migrations/`) and the documented setup (`docs/setup.md`). Examples are: sending to someone who unsubscribed or never signed up, reading or changing subscribers without the admin token or an OAuth grant, sending to a list without a human approval, forging SES/SNS events, reading personal data from public pages, and anything that runs code in a reader's or an admin's browser.

The security model is described in [README.md](README.md#security-model), [docs/mcp.md](docs/mcp.md), [docs/dashboard.md](docs/dashboard.md) and [docs/signup.md](docs/signup.md).

## Out of scope

Weaknesses of a single installation's configuration (a weak admin token, `DEV_IDENTITY` set in production, a missing Cloudflare Access application), and attacks that need the AWS or Cloudflare account itself.
