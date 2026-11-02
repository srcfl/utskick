# Contributing

Thank you for helping. A few rules keep Utskick safe to run with real subscribers.

1. **Tests first.** Add or change a test in `test/` before the code, and make sure it fails without your change. `npm test` must pass.
2. **Typecheck and build.** `npm run typecheck` and `UTSKICK_CONFIG=config/example.json npx cf build` must pass.
3. **No real data.** Fixtures use `example.com` (or another reserved domain) and the SES mailbox simulator. Never commit an export, a token, a key or an account id.
4. **Nothing installation-specific in `src/`.** Organization, lists, senders and domains belong in `config/*.json`.
5. **Schema changes** go in a new file under `migrations/`; never edit one that has been applied.
6. **Privacy.** Pages, logs, stats and the audit log must not show an address or a name; the tests check this.

By contributing you agree that your contribution is licensed under the GNU Affero General Public License v3.0, like the rest of the project.

See [CLAUDE.md](CLAUDE.md) for the conventions coding agents follow here; they apply to people too.
