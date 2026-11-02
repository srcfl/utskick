// What one installation sends: who it is, its lists, and how each list's mail looks.
// It comes from a JSON file (config/*.json) through the CONFIG binding; nothing here is Sourceful's.

export interface ListConfig {
  name: string;        // on the unsubscribe page and in the List-Id header
  from: string;        // "Name <address>" on a domain verified in SES
  replyTo?: string;
  opens?: boolean;     // add the open pixel; only a resend to those who did not open needs it
  fname?: string;      // stands in for *|FNAME|* when there is no first name
  // Id of the consent text sign-up forms show for this list now. A form sign-up must name it;
  // a list without one takes no form sign-ups. Change it whenever the text changes (docs/signup.md).
  consent?: string;
}

// A sign-up form on a website (docs/signup.md). Its name in `forms` is stored as each sign-up's source.
export interface FormConfig {
  lists: string[];       // the lists it may sign people up for
  origins?: string[];    // where the page is served from, e.g. https://example.com: exact match, no path
  key?: boolean;         // posted by a server with the form's key from FORM_KEYS, never from a browser
}

export interface Config {
  organization: string;  // shown on the pages readers land on
  homepage: string;      // "sign up again" link after unsubscribing
  support: string;       // contact address on those pages
  lists: Record<string, ListConfig>;
  // Who may sign in to connect an assistant or approve a send. Nobody when empty.
  admins?: string[];
  // The only addresses an assistant's test send may reach.
  testAllowlist?: string[];
  // Cloudflare Access in front of /oauth/authorize and /approve/ (docs/mcp.md).
  access?: AccessConfig;
  // Website forms that may post to /subscribe. None when empty.
  forms?: Record<string, FormConfig>;
}

export interface AccessConfig {
  teamDomain: string;    // e.g. example.cloudflareaccess.com
  audience: string;      // the Access application's AUD tag
}

export function isList(config: Config, id: unknown): id is string {
  return typeof id === 'string' && Object.hasOwn(config.lists, id);
}
