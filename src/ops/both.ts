import type { App } from '../app.ts';
import { now } from '../core/clock.ts';
import { displayName } from '../ingest/brand.ts';
import { audit, event } from '../db/log.ts';
import { markReminded, markSent, OpsError, pitchOf } from './actions.ts';
import { sendPitch, type PitchStage as Stage } from './outreach.ts';
import { tederMark, tederState, type TederLead } from './tederLeads.ts';

// One store, both products, from Toran's lead page (the owner, 2026-11-08: "i want to be able to build only toran or
// only teder for a page, or both. i want to be able to send them 2 demos or 1"). Toran's own demo is sent as before
// (actions.ts sendNow); here, Teder's alone from Toran's page, and the one message with both demos (the template
// openfrequency_pitch, ops/outreach.ts). Every limit of outreach.ts holds: one way out for both products, a message with
// both demos counted once in the day's cap and as both products' pitch at its stage, no night, Shabbat or holiday,
// Meta's quality read first. Each one throws OpsError with the operator's sentence when it did not go, and marks
// nothing then.

async function storeOf(app: App, id: number) {
  const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [id]);
  if (!s) throw new OpsError('לא מצאתי את החנות');
  return s;
}

async function tederLeadOf(app: App, s: { id: number; domain: string }): Promise<TederLead> {
  const st = await tederState(app, s);
  if ('error' in st) throw new OpsError(st.error);
  if (!st.lead?.demo?.pageUrl) throw new OpsError('הדמו של תדר לחנות הזו עוד לא באוויר.');
  return st.lead;
}

/** Which of Teder's messages is due: the first while its demo waits to be sent, the one reminder once it is due. */
function tederStage(lead: TederLead): Stage {
  if (lead.stage === 'demo_ready') return 'first';
  if (lead.reminderDue) return 'reminder';
  if (lead.sentAt && !lead.reminderSentAt && ['sent', 'opened'].includes(lead.stage)) throw new OpsError('עוד לא הזמן לתזכורת של תדר.');
  throw new OpsError('אין לתדר הודעה לשלוח לחנות הזו עכשיו.');
}

/** Teder's message alone, from our number, then the Teder lead marked as "שלחתי" marks it. */
export async function sendTeder(app: App, storeId: number, by: string): Promise<string> {
  const s = await storeOf(app, storeId);
  const lead = await tederLeadOf(app, s);
  const stage = tederStage(lead);
  const phone = lead.whatsapp || s.contact_whatsapp;
  if (!phone) throw new OpsError('אין לחנות הזו מספר וואטסאפ מהאתר שלה, אז מהמספר שלנו לא שולחים לה.');
  const out = await sendPitch(app, { product: 'teder', stage, phone, name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain, url: lead.demo!.pageUrl!, ref: `store:${s.id}`, by });
  if (!out.sent) throw new OpsError(out.said);
  await event(app.db, s.id, 'teder_pitch', { stage, by });
  const marked = await tederMark(app, s, stage, by);
  const said = stage === 'first' ? 'הדמו של תדר נשלח בוואטסאפ מהמספר שלנו.' : 'התזכורת של תדר נשלחה בוואטסאפ מהמספר שלנו.';
  return 'error' in marked ? `${said} תדר לא סימן את זה אצלו (${marked.error}), אז כדאי לסמן ב/leads של תדר.` : `${said} תדר סימן שנשלח.`;
}

/**
 * The one message with both demos: Toran's page and Teder's slideshow, each its own button. The stage is the same for
 * both: the first message while neither went, or the one reminder once both are due. Then both are marked sent.
 */
export async function sendBoth(app: App, storeId: number, by: string): Promise<string> {
  const s = await storeOf(app, storeId);
  const p = await pitchOf(app, 'toran', String(storeId));
  if ('error' in p) throw new OpsError(p.error);
  if (!p.url) throw new OpsError('אין לתורן עמוד באוויר לחנות הזו.');
  if (!p.phone) throw new OpsError('אין לחנות הזו מספר וואטסאפ מהאתר שלה, אז מהמספר שלנו לא שולחים לה.');
  const lead = await tederLeadOf(app, s);
  const stage = tederStage(lead);
  if (stage !== p.stage) throw new OpsError(stage === 'first' ? 'לתורן כבר נשלחה הודעה, ולתדר עוד לא: אפשר לשלוח את תדר לבד.' : 'לתדר כבר נשלחה הודעה, ולתורן עוד לא: אפשר לשלוח את תורן לבד.');
  if (p.stage === 'reminder' && s.followup_due_at && new Date(s.followup_due_at).getTime() > now()) throw new OpsError('עוד לא הזמן לתזכורת של תורן.');
  const out = await sendPitch(app, { product: 'both', stage: p.stage, phone: p.phone, name: p.name, url: p.url, url2: lead.demo!.pageUrl!, ref: `store:${s.id}`, by });
  if (!out.sent) throw new OpsError(out.said);
  if (p.stage === 'first') await markSent(app, 'toran', String(s.id), by);
  else await markReminded(app, 'toran', String(s.id), by);
  await audit(app.db, { actor: by, action: 'pitch_both', storeId: s.id, detail: { stage: p.stage } });
  const marked = await tederMark(app, s, p.stage, by);
  const said = p.stage === 'first' ? 'נשלחה הודעה אחת עם שני הדמואים, וסומן שנשלח בתורן. התזכורת האחת תחכה בעוד ארבעה ימים.' : 'נשלחה תזכורת אחת לשניהם. זו הייתה ההודעה האחרונה אליהם, אלא אם יכתבו.';
  return 'error' in marked ? `${said} תדר לא סימן את זה אצלו (${marked.error}), אז כדאי לסמן ב/leads של תדר.` : `${said} גם תדר סימן.`;
}
