import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { readHome, type Social } from './signals.ts';

// A store's own Instagram, TikTok and Facebook, read for a store found before Toran read them (2026-11-05, leads/
// signals.ts socialProfile), so the shared lead page can say them (the owner, 2026-11-12: "i want each store to have a
// short description, so that i will know if i should build toran/teder/both/neither for that store"). Read as
// detection reads them (leads/detect.ts): the home page, then its contact page for a network the home page had none
// of. Kept as saveLead keeps them (leads/store.ts): signals.social with the networks found, a profile already kept never
// replaced. A site that does not answer is left as it was, so the page still says nothing about its profiles.

/** The stores to read: a lead's, no customer's, whose signals have no social at all (never read). */
export const SOCIAL_UNREAD = "workspace_id IS NULL AND status <> 'company' AND NOT (COALESCE(signals, '{}'::jsonb) ? 'social')";

export async function readSocial(app: App, store: { id: number; url: string }): Promise<Social | null> {
  let found: Social;
  try {
    const home = await app.fetcher(store.url, { accept: 'text/html' });
    const signals = readHome(home.text, home.url || store.url);
    found = { ...signals.social };
    if ((!found.instagram || !found.tiktok || !found.facebook) && signals.contactLinks.length) {
      const c = await app.fetcher(signals.contactLinks[0], { accept: 'text/html' }).catch(() => null);
      if (c) {
        const cs = readHome(c.text, c.url).social;
        found = { instagram: found.instagram || cs.instagram, tiktok: found.tiktok || cs.tiktok, facebook: found.facebook || cs.facebook };
      }
    }
  } catch {
    return null;
  }
  const kept = Object.fromEntries(Object.entries(found).filter(([, v]) => v));
  // A profile kept already wins (the right side of ||), as saveLead's merge has it.
  await app.db.query(
    `UPDATE stores SET signals = COALESCE(signals, '{}'::jsonb) || jsonb_build_object('social', $2::jsonb
       || CASE WHEN jsonb_typeof(signals->'social') = 'object' THEN jsonb_strip_nulls(signals->'social') ELSE '{}'::jsonb END)
     WHERE id = $1`,
    [store.id, J(kept)],
  );
  return found;
}
