import type { App } from '../app.ts';
import { prefixed } from '../core/hebrew.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { monthOf } from '../plans.ts';
import { shareOf, stopped } from '../agent/spend.ts';
import { ownersOf } from './identity.ts';
import { notifyOwners } from './notify-client.ts';

// The owner is told when Toran stops answering on its own until the month ends (agent/spend.ts, past half of what the
// workspace pays). The website's terms and FAQ promise it: "בשימוש חריג מאוד, הרבה מעבר לחבילה, תורן יכול להפסיק
// לענות לבד עד החודש הבא, ואז הוא מעביר אליכם כל שאלה. אם זה קורה, אנחנו מודיעים לכם." (the owner, 2026-11-11). So:
//
//   Today     a line at the top while the stop lasts (pages/customer.ts), gone once the operator lifts it
//   email     one, to the workspace's owners, when the stop starts (the job owner_paused, asked for once a month with
//             the operator's alert): through accounts as conversation_waiting, the kind an owner already gets when a
//             customer waits for them (accounts takes only Toran's two kinds), and Toran's own mail when accounts could
//             not decide, as the waiting digest does (owners/waiting.ts)
//
// Never a cost, a cap or a share: the words are the terms' own, "שימוש חריג מאוד, הרבה מעבר לחבילה".

const DAY_MONTH = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });

/** "1 בדצמבר": the day the stop ends, the first of the month after `month` ("2026-11"). */
export function untilHe(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return DAY_MONTH.format(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 12));
}

/** What the owner reads, on Today and in the email: when it ends, why in the terms' words, and where the questions wait. */
export function pausedCopy(month: string, store?: string | null): { title: string; text: string } {
  const where = store ? ` ${prefixed('ב', store)}` : '';
  return {
    title: `עד ${untilHe(month)} תורן מעביר אליכם כל שאלה של לקוח${where}`,
    text: 'החודש היה שימוש חריג מאוד, הרבה מעבר לחבילה, ולכן תורן לא עונה לבד עד החודש הבא, אלא אם נפעיל אותו שוב לפני כן. השאלות מחכות לכם בתיבה, ואפשר לענות להן משם.',
  };
}

/**
 * The job: the email, once a workspace and month, and only while the stop still holds (the operator may have lifted it
 * since it was asked for). Throws when nobody could be asked, so the queue tries again.
 */
export async function pausedNotice(app: App, workspaceId: number, month: string): Promise<{ sent: number; why?: string }> {
  const { db } = app;
  if (month !== monthOf()) return { sent: 0, why: 'another month' };
  if (!stopped(await shareOf(app, workspaceId))) return { sent: 0, why: 'the model answers again' };
  if (await db.one("SELECT 1 FROM events WHERE kind = 'owner_paused' AND data->>'workspace' = $1 AND data->>'month' = $2", [String(workspaceId), month])) return { sent: 0, why: 'already told' };
  const stores = await db.query<{ id: number; name: string | null; domain: string; brand: any; brand_override: any }>('SELECT id, name, domain, brand, brand_override FROM stores WHERE workspace_id = $1 ORDER BY id', [workspaceId]);
  if (!stores.length) return { sent: 0, why: 'no store' };
  const name = stores.length === 1 ? displayName(stores[0].brand_override?.name, stores[0].brand?.name, stores[0].name) || stores[0].domain : null;
  const copy = pausedCopy(month, name);
  const link = `${String(app.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/chats?state=waiting`;
  const text = `${copy.text}\n\n${link}`;
  const told = (sent: number, by: string) => event(db, stores[0].id, 'owner_paused', { workspace: String(workspaceId), month, sent, by });
  const r = await notifyOwners(app, workspaceId, 'conversation_waiting', copy.title, text, link);
  if (r.ok) {
    await told(r.sent, 'accounts');
    return { sent: r.sent };
  }
  // accounts' own no (the day's limit, Toran off for the workspace) stands.
  if (r.status === 429 || r.status === 409) {
    await told(0, `accounts: ${r.why}`);
    return { sent: 0, why: `accounts: ${r.why}` };
  }
  const addresses = [...new Set(((await ownersOf(app, workspaceId)) || []).map((o) => String(o.user.email || '').toLowerCase()))].filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!app.mail || !addresses.length) throw new Error(`the owners of workspace ${workspaceId} could not be told that Toran passes every question to them: accounts ${r.why}${app.mail ? ', no owner email' : ', and email is off here'}`);
  let sent = 0;
  for (const address of addresses) {
    try {
      await app.mail.notice(address, copy.title, text);
      sent++;
    } catch (e: any) {
      app.log(`[paused] the email to an owner of workspace ${workspaceId} failed: ${e?.message || e}`);
    }
  }
  if (!sent) throw new Error(`no email reached the owners of workspace ${workspaceId}`);
  await told(sent, 'mail');
  return { sent };
}
