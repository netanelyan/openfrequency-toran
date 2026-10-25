import { createHmac, timingSafeEqual } from 'node:crypto';
import { toIntl } from '../core/urls.ts';
import { LIMITS } from './policy.ts';
import type { ChannelAdapter, ChannelLimits, Inbound, Sent } from './types.ts';

// WhatsApp's adapters, behind the channel interface (types.ts):
//   parse(request)        -> the inbound messages in a webhook call (signature checked)
//   send(to, text, ctx)   -> one outbound message
//
//   twilio   Twilio's WhatsApp API: form-encoded webhooks signed with X-Twilio-Signature
//            (HMAC-SHA1 of the URL plus the sorted fields, keyed by the auth token),
//            replies through the REST API. $0.005 a message each way.
//   sim      the simulator: inbound from the dev page and the tests, outbound into an
//            in-memory outbox. No network.
//
// THE RULE: nothing is ever sent to a person who did not write first, with one exception. send() takes the
// inbound message it answers, and send.ts is the only caller; the 24-hour service window is checked there before
// every send. push() is the exception, for the owner line only (src/owners/): an image in answer to the owner, or a
// message Toran starts to a business owner's verified, opted-in number, and outside the 24 hours that is an approved
// template only. send.ts (images in an answer) and owners/notify.ts are its only callers.

export type { Inbound, Sent };

/** One message push() sends: text, an image (with its caption), or an approved template with its variables. */
export type WaOut = { text?: string; mediaUrl?: string; template?: { name: string; sid: string; vars: string[] }; from?: string | null };

export interface WaProvider extends ChannelAdapter {
  channel: 'whatsapp';
  kind: 'twilio' | 'sim' | 'meta_line'; // meta_line: our own numbers on Meta's Cloud API (lines.ts)
  push(to: string, msg: WaOut): Promise<Sent>;
}

export const BSP_USD_PER_MESSAGE = 0.005;

/** Twilio takes at most 1,600 characters in one WhatsApp body, under WhatsApp's own 4,096; the simulator acts the same. */
const TWILIO_LIMITS: ChannelLimits = { ...LIMITS.whatsapp, maxChars: 1600 };

/** Twilio's signature: base64 HMAC-SHA1 over the full URL and each field name+value, sorted by name. */
export function twilioSignature(authToken: string, url: string, form: Record<string, string>): string {
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function twilioProvider({ accountSid, authToken, from, webhookUrl, fetchImpl = fetch }: { accountSid: string; authToken: string; from: string; webhookUrl: string; fetchImpl?: typeof fetch }): WaProvider {
  // A message goes out from the number it answers (the demo number or the owner line), else from TWILIO_WHATSAPP_FROM.
  const post = async (fields: Record<string, string>, sender?: string | null) => {
    const own = String(sender || from).replace(/^\+/, '');
    const body = new URLSearchParams({ From: `whatsapp:+${own}`, ...fields });
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio refused the message (${res.status}${out?.code ? `, code ${out.code}` : ''}): ${String(out?.message || '').slice(0, 200)}`);
    return { id: String(out.sid || ''), usd: BSP_USD_PER_MESSAGE };
  };
  return {
    channel: 'whatsapp',
    kind: 'twilio',
    limits: TWILIO_LIMITS,
    inboundUsd: BSP_USD_PER_MESSAGE,
    parse({ form, headers }) {
      const given = String(headers['x-twilio-signature'] || '');
      const want = twilioSignature(authToken, webhookUrl, form);
      const a = Buffer.from(given);
      const b = Buffer.from(want);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      const phone = toIntl(String(form.From || '').replace(/^whatsapp:/, ''));
      if (!phone || !form.MessageSid) return [];
      return [{ from: phone, text: String(form.Body || ''), id: String(form.MessageSid), profileName: form.ProfileName || null, to: toIntl(String(form.To || '').replace(/^whatsapp:/, '')) }];
    },
    send(to, text, inReplyTo) {
      return post({ To: `whatsapp:+${to}`, Body: text }, inReplyTo.to);
    },
    // A template goes by its Content SID (Twilio's copy of the template Meta approved), its variables numbered from 1.
    push(to, msg) {
      if (msg.template) return post({ To: `whatsapp:+${to}`, ContentSid: msg.template.sid, ContentVariables: JSON.stringify(Object.fromEntries(msg.template.vars.map((v, i) => [String(i + 1), v]))) }, msg.from);
      return post({ To: `whatsapp:+${to}`, Body: msg.text || '', ...(msg.mediaUrl ? { MediaUrl: msg.mediaUrl } : {}) }, msg.from);
    },
    ack: () => ({ type: 'text/xml; charset=utf-8', body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' }),
  };
}

export function simProvider(): WaProvider {
  const outbox: NonNullable<WaProvider['outbox']> = [];
  let n = 0;
  return {
    channel: 'whatsapp',
    kind: 'sim',
    limits: TWILIO_LIMITS,
    inboundUsd: 0,
    outbox,
    parse({ form, raw }) {
      let data: any = form;
      if (!data.from && raw?.trim().startsWith('{')) {
        try {
          data = JSON.parse(raw);
        } catch {
          return [];
        }
      }
      const phone = toIntl(String(data.from || ''));
      if (!phone) return [];
      return [{ from: phone, text: String(data.text || ''), id: String(data.id || `sim-in-${Date.now()}-${n++}`), profileName: data.name || null, ...(data.to ? { to: toIntl(String(data.to)) } : {}) }];
    },
    async send(to, text, inReplyTo) {
      // A reply goes out from the number it answers, as Twilio's does (twilioProvider).
      outbox.push({ to, text, inReplyTo: inReplyTo.id, at: Date.now(), ...(inReplyTo.to ? { from: inReplyTo.to } : {}) });
      return { id: `sim-out-${Date.now()}-${n++}`, usd: 0 };
    },
    async push(to, msg) {
      outbox.push({ to, text: msg.text || '', inReplyTo: '', at: Date.now(), ...(msg.from ? { from: msg.from } : {}), ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl } : {}), ...(msg.template ? { template: msg.template.name, vars: msg.template.vars } : {}) });
      return { id: `sim-out-${Date.now()}-${n++}`, usd: 0 };
    },
    ack: () => ({ type: 'application/json; charset=utf-8', body: '{"ok":true}' }),
  };
}

export function makeWaProvider(env: Record<string, string | undefined> = process.env, _o: { log?: (m: string) => void } = {}): WaProvider {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM && env.TWILIO_WEBHOOK_URL && env.TORAN_WA !== 'sim') {
    return twilioProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_WHATSAPP_FROM, webhookUrl: env.TWILIO_WEBHOOK_URL });
  }
  return simProvider();
}
