import { WorkerEntrypoint } from 'cloudflare:workers';
import { handle } from './app.ts';
import { cron } from './approvals.ts';
import { subscribe, type Signup } from './contacts.ts';
import type { Env } from './env.ts';
import { clientKey, signupAllowed } from './signup.ts';

export default class Mailer extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return handle(request, this.env);
  }

  // Every minute (cloudflare.config.ts): sends what an admin approved, then clears out expired OAuth state.
  async scheduled(_controller: ScheduledController) {
    await cron(this.env);
  }

  // Called by a site of yours over a service binding (docs/signup.md). Not reachable from the internet,
  // but the site's own form is: the same limit as /subscribe holds, per reader when the site passes
  // the reader's address as `ip`, and for the whole site when it does not.
  async subscribe(signup: Signup & { ip?: string }) {
    const source = typeof signup?.source === 'string' ? signup.source.slice(0, 40) : 'form';
    const reader = typeof signup?.ip === 'string' && signup.ip ? clientKey(signup.ip) : 'site';
    if (!await signupAllowed(this.env, `rpc:${source}:${reader}`)) throw new Error('rate_limited');
    return subscribe(this.env, signup);
  }
}
