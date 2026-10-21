import { createHmac, timingSafeEqual } from 'node:crypto';
import { toIntl } from '../core/urls.ts';

// The WhatsApp side, behind two functions so the BSP is one file:
//   parse(request)        -> the inbound messages in a webhook call (signature checked)
//   send(to, text, ctx)   -> one outbound message
//
//   twilio   Twilio's WhatsApp API: form-encoded webhooks signed with X-Twilio-Signature
//            (HMAC-SHA1 of the URL plus the sorted fields, keyed by the auth token),
//            replies through the REST API. $0.005 a message each way.
//   sim      the simulator: inbound from the dev page and the tests, outbound into an
//            in-memory outbox. No network.
//
// THE RULE: nothing is ever sent to a person who did not write first. send() takes the
// inbound message it answers, and the router (router.ts) is the only caller; the
// 24-hour service window is checked there before every send.

export type Inbound = { from: string; text: string; id: string; profileName?: string | null };
export type Sent = { id: string; usd: number };

export interface WaProvider {
  kind: 'twilio' | 'sim';
  /** Parse a webhook call; null when its signature does not check out. */
  parse(input: { raw: string; form: Record<string, string>; headers: Record<string, string | string[] | undefined>; url: string }): Inbound[] | null;
  send(to: string, text: string, inReplyTo: Inbound): Promise<Sent>;
  /** The webhook's answer body (Twilio wants TwiML; an empty Response sends nothing). */
  ack(): { type: string; body: string };
  outbox?: { to: string; text: string; inReplyTo: string; at: number }[];
}

export const BSP_USD_PER_MESSAGE = 0.005;

/** Twilio's signature: base64 HMAC-SHA1 over the full URL and each field name+value, sorted by name. */
export function twilioSignature(authToken: string, url: string, form: Record<string, string>): string {
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function twilioProvider({ accountSid, authToken, from, webhookUrl, fetchImpl = fetch }: { accountSid: string; authToken: string; from: string; webhookUrl: string; fetchImpl?: typeof fetch }): WaProvider {
  return {
    kind: 'twilio',
    parse({ form, headers }) {
      const given = String(headers['x-twilio-signature'] || '');
      const want = twilioSignature(authToken, webhookUrl, form);
      const a = Buffer.from(given);
      const b = Buffer.from(want);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      const phone = toIntl(String(form.From || '').replace(/^whatsapp:/, ''));
      if (!phone || !form.MessageSid) return [];
      return [{ from: phone, text: String(form.Body || ''), id: String(form.MessageSid), profileName: form.ProfileName || null }];
    },
    async send(to, text) {
      const body = new URLSearchParams({ From: `whatsapp:${from.startsWith('+') ? from : `+${from}`}`, To: `whatsapp:+${to}`, Body: text });
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio refused the message (${res.status}${out?.code ? `, code ${out.code}` : ''}): ${String(out?.message || '').slice(0, 200)}`);
      return { id: String(out.sid || ''), usd: BSP_USD_PER_MESSAGE };
    },
    ack: () => ({ type: 'text/xml; charset=utf-8', body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' }),
  };
}

export function simProvider(): WaProvider {
  const outbox: NonNullable<WaProvider['outbox']> = [];
  let n = 0;
  return {
    kind: 'sim',
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
      return [{ from: phone, text: String(data.text || ''), id: String(data.id || `sim-in-${Date.now()}-${n++}`), profileName: data.name || null }];
    },
    async send(to, text, inReplyTo) {
      outbox.push({ to, text, inReplyTo: inReplyTo.id, at: Date.now() });
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
