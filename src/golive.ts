import type { App } from './app.ts';
import { audit, event } from './db/log.ts';

// Going live, one press, and a pause for the whole store (TORAN-READINESS.md P1-7; migration 063). As Teder does for
// an account (its onboarding ends on "להעלות לאוויר"), a store's owner switches Toran on once its channels and answers
// are ready; until then a message on the store's own channels waits for the owner in the inbox and Toran does not
// answer it (channels/store.ts). The owner can pause the whole store and switch it on again. The demo number and the
// pitch page's sample chat are not gated: the owner tries Toran there before customers meet it.
//
// For the dashboard (Group B): `liveOf` to draw the state, `setLive` behind the owner's button.

export type LiveState = 'never' | 'live' | 'paused';
export type LiveRow = { agent_live_at?: string | Date | null; agent_paused_at?: string | Date | null };

/** Where a store stands, from its row (the two columns of migration 063). */
export const liveState = (s: LiveRow | null | undefined): LiveState => (!s?.agent_live_at ? 'never' : s.agent_paused_at ? 'paused' : 'live');

/** Does Toran answer on this store's own channels? */
export const isLive = (s: LiveRow | null | undefined) => liveState(s) === 'live';

/** A store's state, read from the database. */
export async function liveOf(app: Pick<App, 'db'>, storeId: number): Promise<{ state: LiveState; liveAt: string | null; pausedAt: string | null }> {
  const s = await app.db.one<{ agent_live_at: string | null; agent_paused_at: string | null }>('SELECT agent_live_at, agent_paused_at FROM stores WHERE id = $1', [storeId]);
  return { state: liveState(s), liveAt: s?.agent_live_at ? new Date(s.agent_live_at).toISOString() : null, pausedAt: s?.agent_paused_at ? new Date(s.agent_paused_at).toISOString() : null };
}

/**
 * Switch Toran on (`on`: the first time, or after a pause) or pause it. Pausing a store that never went live does
 * nothing. Audited with who pressed it, and an event the operator's lists read. Returns the new state.
 */
export async function setLive(app: Pick<App, 'db'>, storeId: number, on: boolean, by: string | null = null): Promise<LiveState> {
  const before = (await liveOf(app, storeId)).state;
  if (on) await app.db.query('UPDATE stores SET agent_live_at = COALESCE(agent_live_at, now()), agent_paused_at = NULL WHERE id = $1', [storeId]);
  else if (before === 'live') await app.db.query('UPDATE stores SET agent_paused_at = now() WHERE id = $1', [storeId]);
  const after = (await liveOf(app, storeId)).state;
  if (after !== before) {
    const kind = after === 'live' ? (before === 'never' ? 'went_live' : 'resumed') : 'paused';
    await audit(app.db, { actor: by, action: `toran_${kind}`, storeId });
    await event(app.db, storeId, `toran_${kind}`, { by });
  }
  return after;
}
