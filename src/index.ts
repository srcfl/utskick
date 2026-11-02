import { WorkerEntrypoint } from 'cloudflare:workers';
import { handle } from './app.ts';
import { cron } from './approvals.ts';
import { subscribe, type Signup } from './contacts.ts';
import type { Env } from './env.ts';

export default class Mailer extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return handle(request, this.env);
  }

  // Every minute (cloudflare.config.ts): sends what an admin approved, then clears out expired OAuth state.
  async scheduled(_controller: ScheduledController) {
    await cron(this.env);
  }

  // Called by a site of yours over a service binding (docs/signup.md). Not reachable from the internet.
  subscribe(signup: Signup) {
    return subscribe(this.env, signup);
  }
}
