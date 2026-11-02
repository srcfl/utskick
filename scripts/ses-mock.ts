// A stand-in for SES during local development: takes SendEmail calls on port 4566 and writes each
// mail to .dev/outbox/ as JSON and as HTML you can open in a browser. Nothing leaves the machine.
//   node scripts/ses-mock.ts            then set SES_ENDPOINT=http://localhost:4566 in .dev.vars
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const dir = new URL('../.dev/outbox/', import.meta.url);
mkdirSync(dir, { recursive: true });
let n = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.endsWith('/v2/email/outbound-emails')) {
      res.writeHead(404).end();
      return;
    }
    const mail = JSON.parse(body);
    const id = `${Date.now()}-${++n}`;
    const to = mail.Destination.ToAddresses[0].replace(/[^a-z0-9@.-]/gi, '_');
    writeFileSync(new URL(`${id}-${to}.json`, dir), JSON.stringify(mail, null, 2));
    writeFileSync(new URL(`${id}-${to}.html`, dir), mail.Content.Simple.Body.Html.Data);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ MessageId: `local-${id}` }));
  });
}).listen(4566, () => console.log('SES mock on http://localhost:4566, mail goes to .dev/outbox/'));
