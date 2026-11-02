// The audit log: every tool call an assistant makes, and every decision on a send it asked for.
// A summary keeps the arguments that say what happened (a key, a list, a count), never a body,
// and anything shaped like an address is blanked, wherever it turns up.
import type { Env } from './env.ts';

export interface AuditEntry {
  clientId: string;
  subject: string | null;     // the admin whose grant was used
  scope: string | null;
  tool: string;
  summary: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'denied' | 'approved' | 'declined';
  approvedBy?: string | null; // for a send: who approved or declined it
}

const address = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]{2,}/g;

// Walks the value rather than the JSON text: blanking inside JSON could eat an escape and break it.
export function redact<T>(value: T): T {
  if (typeof value === 'string') return value.replace(address, '[address]') as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redact(v)])) as T;
  return value;
}

export function auditStatement(env: Env, e: AuditEntry): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_log (client_id, subject, scope, tool, summary, outcome, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(e.clientId, e.subject, e.scope, e.tool, JSON.stringify(redact(e.summary)), e.outcome, e.approvedBy ?? null);
}

export async function audit(env: Env, e: AuditEntry) {
  await auditStatement(env, e).run();
}
