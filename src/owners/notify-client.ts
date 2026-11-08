import type { App } from '../app.ts';
import { call } from './identity.ts';

// Toran's emails to a workspace's people go through accounts (POST /internal/notify, accounts docs/contracts/notify.json;
// TORAN-READINESS.md P1-9), as Teder's do: accounts knows who is in the workspace and what each chose on
// /notifications, sends from its address, and holds the limit (three of one kind a day). Toran's kinds are two:
// conversation_waiting (owners/waiting.ts) and monthly (owners/reports.ts). The link must be https on openfrequency.co.il.

export type ToranKind = 'conversation_waiting' | 'monthly';
export type Notified = { ok: true; sent: number } | { ok: false; status: number; why: string; reachable: boolean };

export async function notifyOwners(app: App, workspace: number, kind: ToranKind, subject: string, text: string, link: string): Promise<Notified> {
  const r = await call(app, 'POST', '/internal/notify', { workspace, product: 'toran', kind, subject, text, link }, 8000);
  if (r.status === 202) return { ok: true, sent: Number(r.body?.sent) || 0 };
  // 503 is ours (OF_INTERNAL_TOKEN unset, accounts unreachable) or accounts' own: accounts did not decide anything.
  return { ok: false, status: r.status, why: String(r.body?.error || `HTTP ${r.status}`), reachable: r.status !== 503 };
}
