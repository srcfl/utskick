import type { Config } from './config.ts';

export interface Env {
  DB: D1Database;
  IMAGES?: R2Bucket;
  CONFIG: Config;                 // the installation's lists and names, from config/*.json
  PUBLIC_URL: string;             // e.g. https://news.example.com; every link in a mail starts here
  ADMIN_TOKEN: string;            // bearer token for /admin, used by the CLI
  AWS_REGION: string;             // where SES runs, e.g. eu-central-1
  AWS_ACCESS_KEY_ID: string;      // IAM user allowed ses:SendEmail and nothing else
  AWS_SECRET_ACCESS_KEY: string;
  SES_ENDPOINT?: string;          // only for local development against scripts/ses-mock.ts
  SES_CONFIGURATION_SET: string;  // publishes bounces, complaints and deliveries to SNS
  SNS_TOPIC_ARN: string;          // the only topic /hooks/ses accepts
  FORM_KEYS?: string;             // JSON {"<form>": "<key>"} for the forms with key: true (docs/signup.md)
  STATUS_KEY?: string;            // bearer token for POST /subscribe/status; never a form key (docs/signup.md)
  SIGNUP_LIMITER?: RateLimit;     // Workers Rate Limiting for /subscribe; without it (tests) a counter in memory
  STATUS_LIMITER?: RateLimit;     // Workers Rate Limiting for /subscribe/status; without it (tests) a counter in memory
  DEV_IDENTITY?: string;          // only under `cf dev` and in tests: the admin every sign-in is (src/identity.ts)
}
