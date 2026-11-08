import type { App } from '../app.ts';
import { foundStore } from './stores.ts';
import { tederSite } from './sources.ts';

// One store, both products, from Toran's lead page (the owner, 2026-11-08: "i want the admin lead page to be connected.
// i want to be able to build only toran or only teder for a page, or both. i want to be able to send them 2 demos or
// 1"). Teder keeps its own leads and builds its own demos; Toran asks it on this machine (TEDER_SITE_INTERNAL, with
// OF_INTERNAL_TOKEN), as test/fixtures/teder-leads.json says (the same file in Teder, its src/web/leads-internal.js):
//
//   GET  /internal/leads/state   what Teder has of the store: its stage and its demo
//   GET  /internal/leads/list    every Teder lead, for the shared lead list on accounts' /admin (ops/leadsAdmin.ts)
//   POST /internal/leads/demo    Toran's store as Teder's lead, and its Teder demo built
//   POST /internal/leads/mark    the Teder lead marked sent, when one message from our number carried both demos
//
// Nothing here throws: a Teder that does not answer is { error } in the operator's words, and the page says so.

export type TederDemo = { id: number; status: string; building: boolean; pageUrl: string | null; error: string | null; reviewUrl: string };
export type TederLead = { id: number; stage: string; sentAt: string | null; reminderSentAt: string | null; reminderDue: boolean; whatsapp: string | null; demo: TederDemo | null; leadUrl: string };

const MIN_TOKEN = 32;
const TIMEOUT_MS = 8000;
export const TEDER_DOWN = 'תדר לא ענה כרגע, אז אי אפשר לראות או לבנות את הדמו שלו מכאן. אפשר לנסות שוב בעוד רגע.';

async function ask(app: App, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any | null> {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < MIN_TOKEN) return null;
  try {
    const r = await fetch(`${tederSite(app.env)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      app.log(`[teder-leads] ${method} ${path}: ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e: any) {
    app.log(`[teder-leads] ${method} ${path}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
    return null;
  }
}

/** What Teder has of this store: { lead } (null when none), or { error } when Teder did not answer. */
export async function tederState(app: App, s: { id: number; domain: string }): Promise<{ lead: TederLead | null } | { error: string }> {
  const b = await ask(app, 'GET', `/internal/leads/state?${new URLSearchParams({ toran: String(s.id), domain: s.domain })}`);
  if (!b || b.ok !== true) return { error: TEDER_DOWN };
  return { lead: b.lead || null };
}

export type TederListed = TederLead & { toranId: string | null; domain: string; name: string | null };

/** Every Teder lead at once (GET /internal/leads/list), for the shared lead list: { leads } or { error }. */
export async function tederList(app: App): Promise<{ leads: TederListed[] } | { error: string }> {
  const b = await ask(app, 'GET', '/internal/leads/list');
  if (!b || b.ok !== true || !Array.isArray(b.leads)) return { error: TEDER_DOWN };
  return { leads: b.leads };
}

/** The store's Teder demo built (or linked): { message, lead } or { error } in the operator's words. */
export async function tederBuild(app: App, storeId: number, by: string): Promise<{ message: string; lead: TederLead | null } | { error: string }> {
  const store = await foundStore(app, storeId);
  if (!store) return { error: 'לא מצאתי את החנות' };
  const b = await ask(app, 'POST', '/internal/leads/demo', { store, by });
  if (!b) return { error: TEDER_DOWN };
  if (b.ok !== true) return { error: String(b.error || 'תדר לא בנה את הדמו') };
  return { message: String(b.message || 'בונים את הדמו של תדר.'), lead: b.lead || null };
}

/** The Teder lead marked sent (first) or reminded: { message } or { error }. */
export async function tederMark(app: App, s: { id: number; domain: string }, stage: 'first' | 'reminder', by: string): Promise<{ message: string } | { error: string }> {
  const b = await ask(app, 'POST', '/internal/leads/mark', { toran: String(s.id), domain: s.domain, stage, by });
  if (!b) return { error: TEDER_DOWN };
  if (b.ok !== true) return { error: String(b.error || 'תדר לא סימן') };
  return { message: String(b.message || 'סומן') };
}
