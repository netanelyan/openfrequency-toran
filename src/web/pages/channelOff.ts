import type { App } from '../../app.ts';
import { type AnyChannel } from '../../channels/config.ts';
import { audit, event } from '../../db/log.ts';
import { liveOf, liveState, type LiveState } from '../../golive.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc } from '../ui.ts';

// "תורן עונה ב..." on each channel's own card: the owner stops Toran on one channel, and starts it again, with one
// switch (migration 076; channels/store.ts holds the message for the owner). The owner, 2026-11-09, on the email card's
// "רוצים לעצור את תורן בערוץ אחד, או בכולם? כתבו לנו בוואטסאפ, ואנחנו מכבים אותו": "i dont understand anything, and i
// am the owner. make everything easy for the user. he also doesnt know anything about tech". Nothing in
// docs/decisions.md or the history said stopping must go through us: the line was written before the store-wide pause
// (golive.ts) existed. So a channel is switched here, and the whole store is stopped from Settings ("להפסיק את תורן
// בכל הערוצים", customer.ts livePanel).
//
// The account's owner switches it (a team member sees where it stands), never view-as (server.ts refuses its posts);
// the store is the session's (server.ts checks /lead/<id>). Turning it off asks for a second press, as the store-wide
// stop does; turning it on does not. Each press is audited, with an event the operator's lists read.

export type OffChannel = AnyChannel | 'web';
const CHANNELS: OffChannel[] = ['whatsapp', 'email', 'messenger', 'instagram', 'web'];
/** "במייל", "בוואטסאפ", "בצ׳אט באתר": the channel after "תורן עונה". */
export const IN_HE: Record<OffChannel, string> = { whatsapp: 'בוואטסאפ', email: 'במייל', messenger: 'במסנג׳ר', instagram: 'באינסטגרם', web: 'בצ׳אט באתר' };

/** The channels Toran is switched off on in this store. */
export async function offChannels(app: Pick<App, 'db'>, storeId: number): Promise<OffChannel[]> {
  const s = await app.db.one<{ agent_off: string[] | null }>('SELECT agent_off FROM stores WHERE id = $1', [storeId]);
  return (s?.agent_off || []).filter((c): c is OffChannel => (CHANNELS as string[]).includes(c));
}

/**
 * Whether Toran answers on a connected channel of the store now: it does ('live'), the store was never switched on
 * ('never'), is paused ('paused'), or the channel alone is switched off ('off'). Every line that says "תורן עונה בו"
 * reads it (the audit of 2026-11-12, P1-1: the lines said so before go-live, while paused and beside "תורן לא עונה כאן").
 */
export type Answering = 'live' | 'never' | 'paused' | 'off';
export async function answeringOn(app: Pick<App, 'db'>, storeId: number, channel: OffChannel): Promise<Answering> {
  const s = await app.db.one<{ agent_live_at: string | null; agent_paused_at: string | null; agent_off: string[] | null }>('SELECT agent_live_at, agent_paused_at, agent_off FROM stores WHERE id = $1', [storeId]);
  const st = liveState(s);
  return st !== 'live' ? st : (s?.agent_off || []).includes(channel) ? 'off' : 'live';
}

/** What Toran does on a connected channel, the line's second half: `live` is the channel's own words for answering. */
export const answersHe = (a: Answering, live: string) => (a === 'live' ? live : a === 'never' ? 'תורן יענה בו מהרגע שמפעילים אותו' : a === 'paused' ? 'תורן מושהה, וההודעות מחכות לכם בשיחות' : 'כרגע תורן לא עונה בו, וההודעות מחכות לכם בשיחות');

/** Switch Toran on or off on one channel of a store. Audited, with an event; nothing when it already stands so. */
export async function setChannelOff(app: Pick<App, 'db'>, storeId: number, channel: OffChannel, off: boolean, by: string | null = null): Promise<boolean> {
  const before = (await offChannels(app, storeId)).includes(channel);
  if (before === off) return false;
  await app.db.query(off ? 'UPDATE stores SET agent_off = array_append(agent_off, $2) WHERE id = $1' : 'UPDATE stores SET agent_off = array_remove(agent_off, $2) WHERE id = $1', [storeId, channel]);
  await audit(app.db, { actor: by, action: off ? 'channel_off' : 'channel_on', storeId, detail: { channel } });
  await event(app.db, storeId, off ? 'channel_off' : 'channel_on', { channel, by });
  return true;
}

/**
 * The switch on a channel's card: "תורן עונה במייל", on or off, and what that means in one line. A team member and
 * view-as see it without the button. While the whole store is not switched on or is paused (golive.ts), the line says
 * the switch is for when it is (the audit of 2026-11-12, P2-22: on beside a paused store).
 */
export function channelSwitch(r: DashReq, storeId: number, channel: OffChannel, off: boolean, store: LiveState = 'live'): string {
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const label = `תורן עונה ${IN_HE[channel]}`;
  const line = store === 'never' ? (off ? 'כבוי כאן, גם אחרי שמפעילים את תורן.' : 'יענה כאן מהרגע שמפעילים את תורן.')
    : store === 'paused' ? (off ? 'כבוי כאן, גם כשמפעילים את תורן שוב.' : 'תורן מושהה בכל הערוצים. כשמפעילים אותו שוב, הוא עונה גם כאן.')
    : off ? `כרגע לא. הודעות ${IN_HE[channel]} מחכות לכם בשיחות.` : `מכבים כשרוצים לענות ${IN_HE[channel]} לבד.`;
  const sw = `<span class="sw${off ? '' : ' on'}" aria-hidden="true"><i></i></span>`;
  const button = may
    ? `<form method="post" action="/lead/${storeId}/channel-off">${csrfField(r.ctx)}<input type="hidden" name="channel" value="${esc(channel)}"><input type="hidden" name="on" value="${off ? '1' : '0'}"><button class="swbtn" type="submit" role="switch" aria-checked="${off ? 'false' : 'true'}"${off ? '' : ` data-confirm="${esc(`לחצו שוב כדי לעצור את תורן ${IN_HE[channel]}`)}"`}><span class="t"><b>${esc(label)}</b><small>${esc(line)}</small></span>${sw}</button></form>`
    : `<div class="swbtn" role="switch" aria-checked="${off ? 'false' : 'true'}" aria-disabled="true"><span class="t"><b>${esc(label)}</b><small>${esc(line)}${r.user.role === 'client_member' ? ' את זה משנה מי שפתח את החשבון.' : ''}</small></span>${sw}</div>`;
  return `<div class="swrow mt12" id="switch-${esc(channel)}">${button}</div>`;
}

/** Where a channel's card is, to come back to after the switch. */
const BACK: Record<OffChannel, (id: number) => string> = {
  whatsapp: (id) => `/lead/${id}/whatsapp`,
  messenger: (id) => `/lead/${id}/messenger`,
  instagram: (id) => `/lead/${id}/instagram`,
  email: () => '/settings#email',
  web: () => '/settings#webchat',
};

export function channelOffRoutes(app: App): Route<DashReq>[] {
  return [
    ['POST', /^\/lead\/(\d+)\/channel-off$/, async (r, m) => {
      if (r.user.role === 'client_member') throw new ActionError('את זה משנה מי שפתח את החשבון.', 403);
      const id = Number(m[1]);
      const channel = String(r.form.channel || '') as OffChannel;
      if (!CHANNELS.includes(channel)) throw new ActionError('אין ערוץ כזה', 404);
      const off = r.form.on !== '1';
      await setChannelOff(app, id, channel, off, r.user.name);
      const store = (await liveOf(app, id)).state;
      const on = store === 'never' ? `תורן יענה ${IN_HE[channel]} מהרגע שמפעילים אותו.` : store === 'paused' ? `תורן יענה ${IN_HE[channel]} כשמפעילים אותו שוב.` : `תורן עונה שוב ${IN_HE[channel]}.`;
      return { redirect: r.ctx.operator ? `/lead/${id}#channels` : BACK[channel](id), message: off ? `תורן לא עונה עכשיו ${IN_HE[channel]}. הודעות שם מחכות לכם בשיחות.` : on };
    }],
  ];
}
