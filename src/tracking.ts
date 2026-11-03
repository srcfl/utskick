// Whether an open or a click came from a machine rather than a person, judged when it arrives.
// Mail servers and security gateways (Microsoft Defender, Proofpoint, Mimecast, Gmail) follow every
// link in a mail to check it, often before anyone has seen it, and Apple Mail's privacy proxy loads
// every image as soon as a mail arrives. Counted as people, they make a B2B list look busier than it is.
//
// Only the verdict is stored (events.machine). The network and the user agent it rests on are read
// here and dropped, so Utskick still keeps no IP address and no user agent.

// Networks that are mail scanners, cloud servers or hosting, not people at a desk. By number for
// the big clouds, whose names are also those of consumer networks (Google Fiber), by name for the rest.
// Not the companies whose web proxies carry their customers' staff (Palo Alto's Prisma Access,
// Forcepoint, Fortinet, Sophos, Zscaler): a click from there is a person. A person on a cloud
// desktop (Windows 365, a VPN on AWS) still counts as a machine; that is the price of the rule.
const machineNetworks = new Set([
  8075, 8068, 8069,          // Microsoft: Defender for Office 365, Outlook.com, Azure
  15169, 396982, 19527,      // Google: Gmail's link checks, Google Cloud
  16509, 14618,              // Amazon Web Services
]);
const machineNames = /\b(proofpoint|mimecast|barracuda|trend ?micro|digitalocean|ovh|hetzner|linode|vultr|choopa|contabo|scaleway|leaseweb|oracle)\b/i;
// Apple's privacy proxy loads images for Apple Mail; a click from Apple's network is a person.
const appleNetworks = new Set([714, 6185]);

// User agents that say what they are, and the empty one. "bot" alone, or as the end of a name
// (Googlebot, Slackbot-LinkExpanding), not inside a phone's (CUBOT).
const machineAgents = /\bbot\b|[a-z](?<!cu)bot[\/\s;-]|crawl|spider|scan|preview|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|headless|phantom|libwww|httpclient|facebookexternalhit|barracuda|proofpoint|mimecast/i;

// A click this soon after SES took the mail is a scanner: nobody has read it yet.
export const scanWindowMs = 30_000;
// Three different links of one mail clicked within this long: a scanner following each link in turn.
// A person opening links in new tabs takes longer.
export const burstMs = 2_000;
export const burstLinks = 3;

interface Network { asn?: number; asOrganization?: string }

function network(request: Request): Network {
  return ((request as Request & { cf?: Network }).cf ?? {}) as Network;
}

function machineAgent(request: Request): boolean {
  const agent = request.headers.get('User-Agent') ?? '';
  return !agent.trim() || machineAgents.test(agent);
}

// An open: Apple's proxy, or a client that says it is not a person. Gmail and Yahoo also load
// images through their own proxies, but only when someone opens the mail, so those count.
export function machineOpen(request: Request): boolean {
  const n = network(request);
  return machineAgent(request) || (n.asn !== undefined && appleNetworks.has(n.asn));
}

// A click: a scanner by its network or its user agent, or one that came before anyone could read
// the mail. The burst rule, which needs the mail's other clicks, is in app.ts.
export function machineClick(request: Request, sentAt: string | null, now = Date.now()): boolean {
  const n = network(request);
  if (machineAgent(request)) return true;
  if (n.asn !== undefined && machineNetworks.has(n.asn)) return true;
  if (n.asOrganization && machineNames.test(n.asOrganization)) return true;
  return sentAt !== null && now - Date.parse(sentAt) < scanWindowMs;
}
