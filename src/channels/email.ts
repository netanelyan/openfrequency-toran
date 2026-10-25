import { createHmac, timingSafeEqual } from 'node:crypto';
import * as cheerio from 'cheerio';
import { LIMITS } from './policy.ts';
import type { ChannelAdapter, Inbound, Sent, SendCtx } from './types.ts';

// Email's adapters, behind the channel interface (types.ts). Each store gets an address on our receiving domain
// (<slug>@TORAN_MAIL_DOMAIN) and forwards its own support mail there; replies go out from that address, with the
// store's name, through Resend.
//
//   resend   inbound: Resend's webhook (email.received), signed by Svix. It carries the metadata only, so the worker
//            fetches the body and the headers (complete()). The same webhook reports bounces and spam complaints,
//            which suppress the address. Outbound: Resend's send API, threaded with In-Reply-To and References.
//   sim      the simulator: a whole email posted as JSON, from the tests and the dev page; replies into an outbox.
//
// What is never answered (automated() says why): auto-replies, bounces and delivery reports, mailing lists and bulk
// mail, mail from no-reply and daemon addresses, and mail from our own domain (a loop). The agent's own replies say
// Auto-Submitted: auto-replied, so a well-behaved autoresponder on the other side does not answer them either.

const API = 'https://api.resend.com';
const TOLERANCE_S = 300;

/** Svix's signature, which Resend's webhooks carry: HMAC-SHA256 of "<id>.<timestamp>.<body>", keyed by the whsec_ secret. */
export function svixSign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function svixOk(secret: string, headers: Record<string, string | string[] | undefined>, body: string, nowMs = Date.now()): boolean {
  const id = String(headers['svix-id'] || '');
  const ts = String(headers['svix-timestamp'] || '');
  const sigs = String(headers['svix-signature'] || '').split(' ').map((s) => s.replace(/^v1,/, '')).filter(Boolean);
  if (!secret || !id || !/^\d+$/.test(ts) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const want = Buffer.from(svixSign(secret, id, ts, body));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** "Name <a@b.c>" -> { name, address }, the address lower-cased. */
export function parseAddress(s: string): { name: string | null; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(s || ''));
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  return { name: null, address: String(s || '').trim().toLowerCase() };
}

type Headers = Record<string, string>;
const lowerHeaders = (h: unknown): Headers => Object.fromEntries(Object.entries((h as Record<string, unknown>) || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
const ids = (s: string | undefined) => [...String(s || '').matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);

/** Why this email must not be answered, or null when a person wrote it. */
export function automated(headers: Headers, from: string, ownDomain: string): string | null {
  const h = (k: string) => String(headers[k] || '').trim().toLowerCase();
  const addr = parseAddress(from).address;
  if (h('auto-submitted') && h('auto-submitted') !== 'no') return 'auto-submitted';
  if (/^(bulk|list|junk|auto_reply)$/.test(h('precedence'))) return `precedence ${h('precedence')}`;
  if (h('list-id') || h('list-unsubscribe')) return 'mailing list';
  if (h('x-autoreply') || h('x-autorespond') || h('x-auto-response-suppress')) return 'auto-reply';
  if (h('return-path') === '<>') return 'bounce';
  if (/multipart\/report|message\/delivery-status/.test(h('content-type'))) return 'delivery report';
  const local = addr.split('@')[0];
  if (/(^|[.+_-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([.+_-]|$)/.test(local) || /^notifications?([.+_-]|$)/.test(local)) return 'no-reply address';
  if (ownDomain && addr.endsWith(`@${ownDomain.toLowerCase()}`)) return 'our own domain';
  return null;
}

/** The new part of an email: the quoted history and the signature cut off. */
export function stripQuoted(text: string): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    // Where the quote starts: Gmail and Apple ("On ... wrote:", "בתאריך ... כתב/ה:"), Outlook's header block, a separator.
    if (/^(On\s.+wrote:|בתאריך\s.+(כתב|כתבה|נכתב).*:|-{2,}\s*Original Message\s*-{2,}|_{5,}|From:\s.+|מאת:\s.+)$/i.test(l)) break;
    if (/^-- ?$/.test(line)) break; // the signature separator
    if (l.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** An HTML email as text: block elements become line breaks, everything else its words. */
export function htmlToText(html: string): string {
  let src = String(html || '');
  const data = /^data:text\/html(?:;charset=[^;,]+)?(;base64)?,/i.exec(src);
  if (data) src = data[1] ? Buffer.from(src.slice(data[0].length), 'base64').toString('utf8') : decodeURIComponent(src.slice(data[0].length));
  const $ = cheerio.load(src);
  $('style, script, head').remove();
  $('blockquote, .gmail_quote, #divRplyFwdMsg').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4').each((_, el) => {
    $(el).append('\n');
  });
  return $.root().text().replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const reSubject = (s: string | undefined) => {
  const subject = String(s || '').trim() || '(בלי נושא)';
  return /^(re|תשובה|השב)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
};
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const asHtml = (text: string) => `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;text-align:right">${text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
const quoteName = (n: string) => `"${n.replace(/["\\\r\n]/g, '')}"`;

/** The message to send: from the store's address with its name, threaded on the email it answers. */
export function outgoing(to: string, text: string, inReplyTo: Inbound, ctx: SendCtx = { who: 'agent' }) {
  const account = String(inReplyTo.account || '');
  const refs = [...new Set([...(inReplyTo.thread?.references || []), inReplyTo.thread?.messageId || inReplyTo.id].filter((x) => /^<[^<>\s]+>$/.test(x)))].slice(-20);
  const headers: Record<string, string> = {};
  if (refs.length) {
    headers['In-Reply-To'] = refs[refs.length - 1];
    headers.References = refs.join(' ');
  }
  if (ctx.who === 'agent') headers['Auto-Submitted'] = 'auto-replied';
  return {
    from: ctx.storeName ? `${quoteName(ctx.storeName)} <${account}>` : account,
    to: [to],
    reply_to: account,
    subject: reSubject(inReplyTo.subject),
    text,
    html: asHtml(text),
    headers,
  };
}

/** A received email's full content (Resend's GET /emails/receiving/:id, or the simulator's post) as an Inbound. */
export function fromEmail(e: any, ownDomain: string, at?: number): Inbound {
  const headers = lowerHeaders(e.headers);
  const from = parseAddress(e.from || headers.from || '');
  const to = [...(e.to || []), ...(e.received_for || [])].map((x: string) => parseAddress(x).address);
  const account = to.find((a) => ownDomain && a.endsWith(`@${ownDomain.toLowerCase()}`)) || to[0] || '';
  const messageId = String(e.message_id || headers['message-id'] || '').trim() || `<resend.${e.id || e.email_id}@${ownDomain || 'unknown'}>`;
  const body = e.text ? String(e.text) : e.html ? htmlToText(String(e.html)) : '';
  return {
    channel: 'email',
    from: from.address,
    profileName: from.name,
    account,
    id: messageId,
    text: stripQuoted(body),
    subject: String(e.subject || headers.subject || ''),
    thread: { messageId, inReplyTo: ids(headers['in-reply-to'])[0] || null, references: ids(headers.references) },
    attachments: (e.attachments || []).filter((a: any) => a.content_disposition !== 'inline').map((a: any) => ({ name: String(a.filename || 'file'), type: String(a.content_type || ''), size: Number(a.size) || 0 })),
    automated: automated(headers, e.from || headers.from || '', ownDomain),
    ...(at ? { at } : {}),
  };
}

/**
 * A notice from us to one of our own customers about their account (a store's WhatsApp needs connecting again,
 * waStore.ts): from toran@ our domain, not threaded, never to a store's customer.
 */
export function noticeMail(domain: string, to: string, subject: string, text: string) {
  return { from: `"OpenFrequency" <toran@${domain}>`, to: [to], subject, text, html: asHtml(text), headers: { 'Auto-Submitted': 'auto-generated' } };
}

export interface EmailAdapter extends ChannelAdapter {
  channel: 'email';
  kind: 'resend' | 'sim';
  domain: string;
  notice(to: string, subject: string, text: string): Promise<Sent>;
}

const ack = () => ({ type: 'application/json; charset=utf-8', body: '{"ok":true}' });

export function resendEmail({ apiKey, webhookSecret, domain, fetchImpl = fetch }: { apiKey: string; webhookSecret: string; domain: string; fetchImpl?: typeof fetch }): EmailAdapter {
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    channel: 'email',
    kind: 'resend',
    domain,
    limits: LIMITS.email,
    inboundUsd: 0, // Resend is a monthly plan, not a price per message
    parse({ raw, headers }) {
      if (!svixOk(webhookSecret, headers, raw)) return null;
      let ev: any;
      try {
        ev = JSON.parse(raw);
      } catch {
        return [];
      }
      const d = ev?.data || {};
      const svixId = String(headers['svix-id'] || '');
      if (ev?.type === 'email.bounced' || ev?.type === 'email.complained') {
        return (d.to || []).map((t: string) => ({ channel: 'email' as const, from: parseAddress(t).address, text: '', id: `resend-event:${svixId}:${t}`, report: ev.type === 'email.bounced' ? ('bounced' as const) : ('complained' as const) }));
      }
      if (ev?.type !== 'email.received' || !d.email_id) return [];
      const stub = fromEmail({ ...d, id: d.email_id }, domain);
      return [{ ...stub, pending: String(d.email_id) }];
    },
    async complete(inbound) {
      if (!inbound.pending) return inbound;
      const res = await fetchImpl(`${API}/emails/receiving/${encodeURIComponent(inbound.pending)}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Resend would not give email ${inbound.pending} (${res.status})`);
      const full = fromEmail(await res.json(), domain, inbound.at);
      return { ...full, id: inbound.id };
    },
    async send(to, text, inReplyTo, ctx) {
      const res = await fetchImpl(`${API}/emails`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(outgoing(to, text, inReplyTo, ctx)), signal: AbortSignal.timeout(15_000) });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${String(out?.message || '').slice(0, 200)}`);
      return { id: String(out.id || ''), usd: 0 } satisfies Sent;
    },
    async notice(to, subject, text) {
      const res = await fetchImpl(`${API}/emails`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(noticeMail(domain, to, subject, text)), signal: AbortSignal.timeout(15_000) });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Resend refused the notice (${res.status}): ${String(out?.message || '').slice(0, 200)}`);
      return { id: String(out.id || ''), usd: 0 };
    },
    ack,
  };
}

export function simEmail({ domain = 'mail.toran.test' }: { domain?: string } = {}): EmailAdapter {
  const outbox: NonNullable<ChannelAdapter['outbox']> = [];
  let n = 0;
  return {
    channel: 'email',
    kind: 'sim',
    domain,
    limits: LIMITS.email,
    inboundUsd: 0,
    outbox,
    parse({ raw }) {
      let e: any;
      try {
        e = JSON.parse(raw || '{}');
      } catch {
        return [];
      }
      if (e.report) return [{ channel: 'email', from: parseAddress(e.from || '').address, text: '', id: `sim-event-${n++}`, report: e.report === 'complained' ? 'complained' : 'bounced' }];
      if (!e.from || !e.to) return [];
      return [fromEmail({ id: `sim-${n++}`, ...e }, domain)];
    },
    async send(to, text, inReplyTo, ctx) {
      const m = outgoing(to, text, inReplyTo, ctx);
      outbox.push({ to, text, inReplyTo: inReplyTo.id, at: Date.now(), from: m.from, subject: m.subject, headers: m.headers });
      return { id: `sim-mail-${Date.now()}-${n++}`, usd: 0 };
    },
    async notice(to, subject, text) {
      const m = noticeMail(domain, to, subject, text);
      outbox.push({ to, text, inReplyTo: '', at: Date.now(), from: m.from, subject, headers: m.headers, notice: true });
      return { id: `sim-mail-${Date.now()}-${n++}`, usd: 0 };
    },
    ack,
  };
}

/** The email adapter for this environment: Resend when its keys are set, else the simulator. */
export function makeEmailAdapter(env: Record<string, string | undefined>): EmailAdapter {
  const domain = String(env.TORAN_MAIL_DOMAIN || '').trim().toLowerCase() || 'mail.toran.test';
  if (env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET && env.TORAN_MAIL_DOMAIN) return resendEmail({ apiKey: env.RESEND_API_KEY, webhookSecret: env.RESEND_WEBHOOK_SECRET, domain });
  return simEmail({ domain });
}
