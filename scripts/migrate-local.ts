// Creates the tables in the local D1 that `cf dev` runs. `cf d1 migrations apply` wants a real
// database id, so locally we go through the dev server's explorer API instead.
//   npm run dev   (in another terminal), then   npm run db:local
import { readdirSync, readFileSync } from 'node:fs';

// The dev server names the local database after the binding and the Worker; ask rather than guess.
const explorer = 'http://localhost:5173/cdn-cgi/local/explorer/api/d1/database';
const { result } = await (await fetch(explorer)).json() as { result: { name: string; uuid: string }[] };
const db = result.find(d => d.name === 'DB');
if (!db) throw new Error('no local D1 bound as DB: is `npm run dev` running?');
const api = `${explorer}/${db.uuid}/raw`;
const run = async (sql: string) => {
  const res = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) });
  const data = await res.json() as { success: boolean; errors: { message: string }[] };
  if (!data.success) throw new Error(data.errors.map(e => e.message).join('; '));
  return data;
};

await run('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
const done = await run('SELECT name FROM d1_migrations') as unknown as { result: { results: { rows: string[][] } }[] };
const applied = new Set(done.result[0].results.rows.map(r => r[0]));
for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
  if (applied.has(name)) continue;
  await run(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  await run(`INSERT INTO d1_migrations (name) VALUES ('${name}')`);
  console.log(`applied ${name}`);
}
console.log('local D1 is up to date');
