import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// docs/setup.md lists what to create in AWS and Cloudflare before the first deploy.
export default defineConfig(async ({ mode }) => {
	// `cf dev` runs in development mode: links point at the local Worker, and mail goes to
	// scripts/ses-mock.ts instead of SES, so a local run can never reach a real inbox.
	const dev = mode === "development";
	// Your installation lives in one JSON file (copy config/example.json). A deploy must name it, so
	// nobody ships mail whose links point at someone else's Worker.
	const shell = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	const file = shell.UTSKICK_CONFIG ?? (dev ? "config/example.json" : undefined);
	if (!file) throw new Error("Set UTSKICK_CONFIG to your installation's config file, e.g. UTSKICK_CONFIG=config/mine.json cf deploy");
	const { default: { deploy, ...site } } = await import(new URL(file, (import.meta as unknown as { url: string }).url).href, { with: { type: "json" } });
	return {
		worker: {
			name: deploy.worker ?? "utskick",
			compatibilityDate: "2026-10-01",
			entrypoint,
			// The deploy attaches this hostname to the Worker and creates its DNS record.
			domains: [new URL(deploy.publicUrl).hostname],
			// Every minute: sends what an admin approved through an assistant (src/approvals.ts),
			// 14 mails a second for up to 50 seconds. CLI sends do not depend on it.
			triggers: [triggers.scheduled({ schedule: "* * * * *" })],
			env: {
				CONFIG: bindings.json(site),
				// D1 in the EU jurisdiction: contacts, lists, sends, deliveries, events.
				DB: bindings.d1({ name: deploy.d1.name, id: deploy.d1.id }),
				// Issue images, served from /img/<sha256>.<ext>.
				IMAGES: bindings.r2({ name: deploy.r2, jurisdiction: "eu" }),
				// POST /subscribe: 10 sign-ups a minute per form and client address (src/signup.ts).
				// The namespace is any number no other rate limiter in the account uses.
				SIGNUP_LIMITER: bindings.rateLimit({ namespace: deploy.signupLimiterNamespace, simple: { limit: 10, period: 60 } }),
				PUBLIC_URL: bindings.text(dev ? "http://localhost:5173" : deploy.publicUrl),
				AWS_REGION: bindings.text(deploy.awsRegion),
				// In development, every sign-in at /oauth/authorize, /approve/ and /dashboard is the first admin,
				// without Cloudflare Access (src/identity.ts). Never set in production.
				...(dev ? { SES_ENDPOINT: bindings.text("http://localhost:4566"), DEV_IDENTITY: bindings.text(site.admins?.[0] ?? "admin@example.com") } : {}),
				SES_CONFIGURATION_SET: bindings.text(deploy.sesConfigurationSet),
				ADMIN_TOKEN: bindings.secret(),
				AWS_ACCESS_KEY_ID: bindings.secret(),
				AWS_SECRET_ACCESS_KEY: bindings.secret(),
				SNS_TOPIC_ARN: bindings.secret(),
				// JSON {"<form>": "<key>"} for the forms in the config that need a key; {} when none do (docs/signup.md).
				FORM_KEYS: bindings.secret(),
			},
		},
	};
});
