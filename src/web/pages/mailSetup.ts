import { resolveMx } from 'node:dns/promises';
import type { App } from '../../app.ts';
import { J } from '../../db/index.ts';
import { audit } from '../../db/log.ts';
import { displayName } from '../../ingest/brand.ts';
import { enabledChannels, storeAddress } from '../../channels/config.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, sendTo } from '../ui.ts';
import { mailDomainPanel } from './mailDomain.ts';
import { channelSwitch, offChannels } from './channelOff.ts';

// The store's email card on Settings, as a guided flow for an owner who knows nothing about tech. The owner,
// 2026-11-09, pasting the card as it was ("מעבירים לכתובת ... את המייל של החנות, למשל ב-Gmail: הגדרות, "העברה ו-POP/IMAP"
// ...", then DNS records, MX and a subdomain): "i dont understand anything, and i am the owner. make everything easy for
// the user. he also doesnt know anything about tech". So the card asks one thing at a time (the project's rule, "Easy
// for users": one action per screen, the main button most prominent, the advanced folded, no codes or mechanics):
//
//   1. pick    "באיזה מייל החנות משתמשת?": Gmail, Outlook או Hotmail, אחר. When Toran knows the store's address (the
//              one read from its site, stores.contact_email, or the one the owner typed), its domain says which: a
//              known free address (gmail.com, outlook.com...), else its MX hosts (Google Workspace, Microsoft 365),
//              and that choice is the main button. Not known, the owner types the address once, and a known provider
//              goes straight to step 2. Choosing connects the channel (the store's address on our domain), as the
//              old "לחבר את המייל" did.
//   2. forward short numbered steps for that provider with its own Hebrew button names, the address to forward to in a
//              box with a big "להעתיק", and a button that opens the provider's forwarding settings. For anything else,
//              a ready message for whoever runs the store's mail.
//   3. confirm Gmail sends a confirmation to the new address before it forwards (support.google.com/mail/answer/10957).
//              It arrives as an automated mail Toran never answers (channels/email.ts automated(), from
//              forwarding-noreply@google.com), and it used to wait in the conversations for the owner to find it.
//              Now this card shows it: the link as "ללחוץ כאן לאישור", the code with its own "להעתיק". The card asks
//              every few seconds while it waits (GET /lead/<id>/mail/state.json, static/app.js data-wait-mail).
//   then      "מחובר" once the owner says it is done, or once a person's mail came through the forwarding.
//
// The store's own sending address (DNS records, a receiving subdomain: pages/mailDomain.ts) moves under a closed "עוד
// אפשרויות", as "לענות מכתובת של החנות (בשביל מי שמנהל לכם את האתר)", with a button that sends that person a message
// saying exactly what to do. The technical words are only in that message.
//
// What is kept on the email account (channel_accounts.meta, the row the channel already has): provider (gmail |
// outlook | other), from (the store's own address, as the owner gave it or the site said), done_at.
//
// UNVERIFIED in the code below, each where it is used: the Hebrew labels of Gmail's and Outlook's settings that Google's
// and Microsoft's help pages did not show in Hebrew, and the Hebrew subject of Gmail's confirmation mail.

export type Provider = 'gmail' | 'outlook' | 'other';
const PROVIDERS: Provider[] = ['gmail', 'outlook', 'other'];
const PROVIDER_HE: Record<Provider, string> = { gmail: 'Gmail', outlook: 'Outlook או Hotmail', other: 'אחר' };

/** The DNS lookup, replaced in the tests (as domainProof.ts's proofDeps). */
export const mxDeps = { resolveMx: (domain: string) => resolveMx(domain) };

// Free addresses whose provider is known without asking DNS, each checked by its MX on 2026-11-09: gmail.com and
// googlemail.com receive on gmail hosts under l.google.com; outlook.com, hotmail.com, live.com and msn.com on
// <x>-com.olc.protection.outlook.com; the older Israeli hotmail.co.il and outlook.co.il on eur.olc.protection.outlook.com.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const OUTLOOK_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.il', 'hotmail.co.il']);
const cache = new Map<string, { p: Provider | null; at: number }>();

const domainOf = (address: string) => String(address || '').trim().toLowerCase().split('@')[1] || '';
/** Is this the provider's own free address (gmail.com, hotmail.com), not a business domain on it? */
const freeAddress = (address: string) => GMAIL_DOMAINS.has(domainOf(address)) || OUTLOOK_DOMAINS.has(domainOf(address));

/**
 * Which provider an address is on: its domain when it is a free one, else its MX hosts. Google Workspace receives on
 * one host under google.com (the one Google's MX page gives today), or for domains set up before 2023 on aspmx.l.google.com and its alt hosts, sometimes with
 * aspmx2.googlemail.com (knowledge.workspace.google.com/admin/domains/set-up-mx-records-for-google-workspace).
 * Microsoft 365 on <domain>.mail.protection.outlook.com, and domains added from the second half of 2026 on
 * <x>.mx.microsoft (techcommunity.microsoft.com, "Modernizing DNS security for Exchange Online mail flow"). Anything
 * else (walla.co.il on iphmx.com, bezeqint.net, 012.net.il) is 'other'; a lookup that fails or takes over 3 seconds is
 * null (not known), so the owner is asked. Kept a day per domain.
 */
export async function providerOf(address: string | null | undefined): Promise<Provider | null> {
  const d = domainOf(String(address || ''));
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  if (GMAIL_DOMAINS.has(d)) return 'gmail';
  if (OUTLOOK_DOMAINS.has(d)) return 'outlook';
  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.p;
  let p: Provider | null = null;
  try {
    const mx = await Promise.race([mxDeps.resolveMx(d), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]);
    const hosts = mx.map((x) => String(x.exchange || '').toLowerCase().replace(/\.$/, ''));
    p = hosts.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h)) ? 'gmail' : hosts.some((h) => /(^|\.)outlook\.com$|\.mx\.microsoft$/.test(h)) ? 'outlook' : hosts.length ? 'other' : null;
  } catch {
    p = null;
  }
  cache.set(d, { p, at: Date.now() });
  return p;
}
/** For the tests: forget what was looked up. */
export const forgetProviders = () => cache.clear();

// ---- Gmail's confirmation, read from the mail Toran held

/**
 * Gmail's forwarding confirmation, from what the store's address received: the newest mail from
 * forwarding-noreply@google.com ("Gmail Team"), with the subject "(#99427480) Gmail Forwarding Confirmation - Receive
 * Mail from <address>" (real copies, lkml.rescloud.iu.edu/2101.2/01750.html and discourse.openehr.org, both 8 digits;
 * the Hebrew subject, if Gmail sends one, UNVERIFIED, so the digits after "#" are read whatever the words are). The
 * code is those digits, or the ones after "Confirmation code" in the text; the link is the first https link to
 * /mail/vf-... on mail-settings.google.com or mail.google.com (both seen in real copies; /mail/uf-... is the one that
 * cancels, never shown). Google's own pages only, so a forged mail cannot put another site behind "ללחוץ כאן לאישור".
 * Null while none came.
 */
export type Confirm = { code: string | null; link: string | null; at: string; conversation: number };
const CONFIRM_FROM = 'forwarding-noreply@google.com';
const GOOGLE_HOSTS = new Set(['mail-settings.google.com', 'mail.google.com']);

export function readConfirm(subject: string, text: string): { code: string | null; link: string | null } {
  const code = /#\s?(\d{6,12})\b/.exec(subject || '')?.[1] || /(?:confirmation code|קוד\s(?:ה)?(?:אישור|אימות))\D{0,20}(\d{6,12})\b/i.exec(text || '')?.[1] || null;
  let link: string | null = null;
  for (const m of String(text || '').matchAll(/https:\/\/[^\s<>"'()]+/g)) {
    try {
      const u = new URL(m[0].replace(/[.,;]+$/, ''));
      if (u.protocol === 'https:' && GOOGLE_HOSTS.has(u.hostname) && /^\/mail\/(u\/\d+\/)?vf-/.test(u.pathname)) {
        link = u.toString();
        break;
      }
    } catch {
      /* not a link */
    }
  }
  return { code, link };
}

async function confirmOf(app: App, accountId: number): Promise<Confirm | null> {
  const m = await app.db.one<{ text: string; subject: string | null; at: string; conversation: number }>(
    "SELECT m.text, c.meta->>'subject' AS subject, m.at, c.id AS conversation FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.account_id = $1 AND c.channel = 'email' AND lower(c.peer) = $2 AND m.role = 'customer' ORDER BY m.id DESC LIMIT 1",
    [accountId, CONFIRM_FROM],
  );
  if (!m) return null;
  const { code, link } = readConfirm(String(m.subject || ''), String(m.text || ''));
  return code || link ? { code, link, at: String(m.at), conversation: m.conversation } : null;
}

// ---- Where the store's email card stands

type MailAccount = { id: number; external_id: string; status: string; meta: any };
export type MailStep = 'pick' | 'forward' | 'confirm' | 'done';
export type MailState = { account: MailAccount | null; on: boolean; address: string; from: string | null; provider: Provider | null; guess: Provider | null; confirm: Confirm | null; step: MailStep };

export async function mailState(app: App, storeId: number): Promise<MailState> {
  const s = await app.db.one<{ id: number; slug: string | null; contact_email: string | null }>('SELECT id, slug, contact_email FROM stores WHERE id = $1', [storeId]);
  const account = await app.db.one<MailAccount>("SELECT id, external_id, status, meta FROM channel_accounts WHERE store_id = $1 AND channel = 'email' ORDER BY id DESC LIMIT 1", [storeId]);
  const on = account?.status === 'active';
  const meta = account?.meta || {};
  // The address the owner gave, or none when they said the site's is not theirs ("זה לא המייל של החנות"), else the site's.
  const from = typeof meta.from === 'string' ? meta.from || null : s?.contact_email || null;
  const provider = on && PROVIDERS.includes(meta.provider) ? (meta.provider as Provider) : null;
  const address = on ? account!.external_id : storeAddress(s || { id: storeId, slug: null }, app.mail?.domain || '');
  // A person's mail through the forwarding says it works, whatever the card was told (and covers a store connected
  // before this card, which never picked a provider).
  const came = on ? await app.db.one("SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.account_id = $1 AND m.role = 'customer' AND m.automated IS NULL LIMIT 1", [account!.id]) : null;
  const confirm = on ? await confirmOf(app, account!.id) : null;
  const step: MailStep = on && (meta.done_at || came) ? 'done' : !provider ? 'pick' : confirm && provider !== 'outlook' ? 'confirm' : 'forward';
  const guess = step === 'pick' && from ? await providerOf(from) : null;
  return { account: on ? account : null, on, address, from, provider, guess, confirm, step };
}

/** Connect the store's email: its own address on our receiving domain (the same as leads.ts's /channels/email). */
export async function connectEmail(app: App, storeId: number, meta: Record<string, unknown>, by: string) {
  const s = await app.db.one<any>('SELECT id, slug, name, domain, brand, brand_override FROM stores WHERE id = $1', [storeId]);
  if (!s || !app.mail) throw new ActionError('המייל עוד כבוי בשרת (TORAN_CHANNELS).');
  const address = storeAddress(s, app.mail.domain);
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'email' AND external_id = $1", [address]);
  if (taken && taken.store_id !== s.id) throw new ActionError('הכתובת הזו כבר שייכת לחנות אחרת.');
  const was = await app.db.one<{ status: string }>("SELECT status FROM channel_accounts WHERE channel = 'email' AND external_id = $1", [address]);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, meta) VALUES ($1, 'email', $2, $3, $4, $5::jsonb) ON CONFLICT (channel, external_id) DO UPDATE SET status = 'active', kind = EXCLUDED.kind, name = EXCLUDED.name, meta = channel_accounts.meta || EXCLUDED.meta, connected_at = CASE WHEN channel_accounts.status = 'active' THEN channel_accounts.connected_at ELSE now() END", [s.id, app.mail.kind, address, name, J(meta)]);
  if (was?.status !== 'active') await audit(app.db, { actor: by, action: 'email_connect', storeId: s.id, detail: { address } });
  return address;
}

// ---- The card

const STEP_OF: Record<Exclude<MailStep, 'done'>, number> = { pick: 1, forward: 2, confirm: 3 };
const stepTag = (n: number) => `<p class="steptag m0">שלב ${n} מתוך 3</p>`;

/** The address to forward to, in its own box with a big copy button. */
const addressBox = (id: string, address: string, primary = true) => `<div class="copybox mt12"><code class="ltr" id="${esc(id)}">${esc(address)}</code><button class="btn${primary ? ' primary' : ''}" type="button" data-copy="#${esc(id)}" data-done="הכתובת הועתקה">${icon('copy')}להעתיק</button></div>`;

/**
 * Where each provider's forwarding settings open. Gmail's tab "Forwarding and POP/IMAP" is #settings/fwdandpop: no
 * Google page gives the link (UNVERIFIED), many guides use it, and it opens Gmail's settings either way. On a computer
 * only: Google's help starts with "פותחים את Gmail במחשב", and no step is in the app. Outlook.com's forwarding page,
 * and Microsoft 365's for a business domain (both UNVERIFIED: no Microsoft page gives them; guides do).
 */
const SETTINGS_URL = {
  gmail: 'https://mail.google.com/mail/u/0/#settings/fwdandpop',
  outlook: 'https://outlook.live.com/mail/0/options/mail/forwarding',
  work: 'https://outlook.office.com/mail/options/mail/forwarding',
};

/**
 * The steps, with the buttons' names as Hebrew Gmail and Outlook show them.
 *
 * Gmail's, quoted from Google's Hebrew help (support.google.com/mail/answer/10957?hl=iw, read 2026-11-09; the page
 * says it may be machine-translated, so the live labels may differ a little): the tab "העברה ו-POP/IMAP" or "העברה",
 * "הוספת כתובת להעברה", "הבא › המשך › אישור", a verification mail to the new address whose link is pressed, "חוזרים
 * לדף ההגדרות ב-Gmail. מרעננים את הדפדפן", "העברת עותק של הודעות נכנסות אל", "שמירת העותק של Gmail בתיבת הדואר
 * הנכנס", "שמירת השינויים". In Google Workspace the admin can turn forwarding off, and then "האפשרויות להעביר
 * אימיילים לא זמינה בהגדרות של Gmail" (knowledge.workspace.google.com, let users automatically forward): the fold for
 * that sends the admin a message.
 *
 * Outlook's, from Microsoft's Hebrew help ("הפעלת העברה אוטומטית ב-Outlook", support.microsoft.com/he-il/office/
 * 7f2670a1-7fff-4475-8a3c-5822d63b0c8e): "הפוך העברה לזמינה" (the Outlook.com tab of the same page says "אפשר
 * העברה"; the live label UNVERIFIED, so both are named), "שמור עותק של הודעות שהועברו", "שמור". Outlook.com asks to
 * turn on two-step verification first when it is off ("תתבקש להפוך אותו לזמין בעת הפעלת ההעברה"). No confirmation
 * mail goes to the new address. Microsoft 365 blocks forwarding outside the organization by default since 2021
 * (learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding): only the admin
 * turns it on, so a business domain's steps carry the message for them.
 */
function forwardSteps(st: MailState, storeId: number, storeName: string): string {
  const p = st.provider!;
  const work = Boolean(st.from && !freeAddress(st.from));
  const subject = `העברה של המייל של ${storeName} לתורן`;
  const forDev = [
    `שלום, אפשר עזרה עם המייל של ${storeName}?`,
    `צריך שכל מייל שמגיע ל-${st.from || 'המייל של החנות'} יעבור אוטומטית (Forwarding) גם לכתובת ${st.address}, וישאר גם בתיבה הרגילה.`,
    ...(p === 'gmail' ? ['אם זה Google Workspace והאפשרות להעביר לא מופיעה ב-Gmail: Admin console, Apps, Google Workspace, Gmail, End User Access, ולסמן Allow users to automatically forward incoming email.'] : []),
    ...(p === 'outlook' ? ['אם זה Microsoft 365 של העסק, העברה לכתובת חיצונית חסומה כברירת מחדל: ב-security.microsoft.com/antispam, ב-Anti-spam outbound policy, משנים את Automatic forwarding rules ל-On - Forwarding is enabled.'] : []),
    'אם נשלח לכתובת קוד אישור, הוא מופיע אצלי בתורן. תודה',
  ].join('\n');
  const open = (url: string, label: string) => `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${icon('ext')}${esc(label)}</a>`;
  const helper = (q: string, why: string) => `<details class="mt12"><summary class="small">${esc(q)}</summary><p class="small mt8 m0">${esc(why)}</p>${sendTo(forDev, subject, 'לשלוח למי שמנהל לכם את המייל', 'btn sm')}</details>`;
  const copy = `<li><b>מעתיקים את הכתובת של תורן</b>${addressBox(`fwd-${storeId}`, st.address)}</li>`;
  if (p === 'gmail') {
    return `<ol class="steps mt12">
    ${copy}
    <li><b>פותחים את ההגדרות של Gmail במחשב</b><span>מהאפליקציה בטלפון זה לא עובד.</span><div class="mt8">${open(SETTINGS_URL.gmail, 'לפתוח את Gmail')}</div></li>
    <li><b>לוחצים "הוספת כתובת להעברה"</b><span>זה בלשונית "העברה". מדביקים את הכתובת, ולוחצים "הבא", "המשך" ו"אישור".</span></li>
  </ol>
  <div class="waitbox mt16" data-wait-mail="/lead/${storeId}/mail/state.json" data-v="${esc(st.step)}">${icon('clock')}<span>עכשיו Gmail שולח לתורן מייל אישור. הוא יופיע כאן לבד תוך דקה, בלי לחפש אותו.</span></div>
  ${work ? helper('לא רואים "הוספת כתובת להעברה"?', 'במייל של עסק, מי שמנהל לכם את המייל צריך לאפשר העברה. אפשר לשלוח לו הודעה מוכנה.') : ''}`;
  }
  if (p === 'outlook') {
    return `<ol class="steps mt12">
    ${copy}
    <li><b>פותחים את ההגדרות של Outlook</b><span>במחשב, או בדפדפן בטלפון.</span><div class="mt8">${open(work ? SETTINGS_URL.work : SETTINGS_URL.outlook, 'לפתוח את Outlook')}</div></li>
    <li><b>מדליקים את ההעברה</b><span>לוחצים "הפוך העברה לזמינה" (או "אפשר העברה"), מדביקים את הכתובת, מסמנים "שמור עותק של הודעות שהועברו" ולוחצים "שמור".</span></li>
  </ol>
  <p class="small muted mt12 m0">אם Outlook מבקש להפעיל קודם אימות דו-שלבי, מפעילים ואז חוזרים לכאן.</p>
  ${work ? helper('Outlook לא נותן להעביר?', 'במייל של עסק, לפעמים רק מי שמנהל לכם את המייל יכול לאשר העברה. אפשר לשלוח לו הודעה מוכנה.') : ''}`;
  }
  return `<ol class="steps mt12">
    ${copy}
    <li><b>מוסיפים אותה להעברה</b><span>בהגדרות של המייל מחפשים "העברה" או "Forwarding", מדביקים את הכתובת ושומרים.</span></li>
  </ol>
  <p class="small muted mt12 m0">לא בטוחים איפה זה? שולחים הודעה מוכנה למי שמנהל לכם את המייל.</p>
  ${sendTo(forDev, subject, 'לשלוח למי שמנהל לכם את המייל', 'btn sm')}`;
}

/** The whole email card for one store on Settings (customer.ts). Empty while email is off on this server. */
export async function mailCard(app: App, r: DashReq, store: { id: number; name: string }): Promise<string> {
  if (!enabledChannels(app.env).has('email') || !app.mail) return '';
  const st = await mailState(app, store.id);
  const ro = Boolean(r.ctx.readOnly);
  const id = store.id;
  const chip = st.step === 'done' ? `<span class="end chip ok">${icon('check')}מחובר</span>` : st.on ? '<span class="end chip sig">באמצע</span>' : '<span class="end chip ghost">לא מחובר</span>';
  const head = `<section class="panel" id="email"><header><h2>המייל</h2>${chip}</header>`;
  const form = (inner: string, fields: Record<string, string>, cls = '') => `<form method="post" action="/lead/${id}/mail/setup"${cls ? ` class="${cls}"` : ''}>${csrfField(r.ctx)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${inner}</form>`;
  const again = !ro && st.on ? form(`<button class="linkbtn small" type="submit">${icon('refresh')}להתחיל מחדש</button>`, { do: 'change' }, 'mt16') : '';

  if (st.step === 'done') {
    const off = (await offChannels(app, id)).includes('email');
    const more = `<details class="more mt16"><summary>עוד אפשרויות</summary>
    <h3 class="small mt12">לענות מכתובת של החנות (בשביל מי שמנהל לכם את האתר)</h3>${await mailDomainPanel(app, r, id, st.account!.external_id)}
    <h3 class="small mt16">הכתובת של תורן</h3><p class="small muted m0">לכאן המייל של החנות עובר.</p>${addressBox(`fwd-${st.account!.id}`, st.address, false)}
    ${ro ? '' : `<div class="row mt16">${form(`<button class="btn sm ghost" type="submit">${icon('refresh')}לחבר מייל אחר</button>`, { do: 'change' })}${postButton(r.ctx, `/lead/${id}/channels/email`, 'לנתק את המייל', { cls: 'btn sm danger', fields: { on: '0' }, confirm: 'לנתק? מיילים שיגיעו לא ייענו.' })}</div>`}
  </details>`;
    return `${head}<p class="m0">${st.from ? `מייל שמגיע ל-<bdi class="ltr">${esc(st.from)}</bdi> עובר לתורן.` : 'המייל של החנות עובר לתורן.'} תורן עונה ממנו בשם החנות, ומה שהוא לא יודע מגיע אליכם בשיחות.</p>
  ${channelSwitch(r, id, 'email', off)}
  ${more}</section>`;
  }

  const storeName = store.name;
  if (st.step === 'pick') {
    const intro = '<p class="m0">לקוחות שכותבים למייל של החנות יקבלו תשובה מתורן. מחברים פעם אחת, בשלושה שלבים קצרים.</p>';
    if (ro) return `${head}${intro}</section>`;
    if (!st.from) {
      return `${head}${stepTag(1)}<h3 class="q1">מה המייל של החנות?</h3>${intro}
  ${form(`<label class="f mt12">הכתובת שלקוחות כותבים אליה<input type="email" name="from" required maxlength="120" dir="ltr" inputmode="email" autocomplete="email" placeholder="shop@yourstore.co.il"></label><button class="btn primary mt12" type="submit">להמשיך</button>`, { do: 'from' })}
  </section>`;
    }
    const choice = (p: Provider) => `<button class="choice${st.guess === p ? ' picked' : ''}" type="submit" name="provider" value="${p}"><b>${esc(PROVIDER_HE[p])}</b>${st.guess === p ? '<small>נראה לנו שזה</small>' : ''}</button>`;
    return `${head}${stepTag(1)}<h3 class="q1">באיזה מייל החנות משתמשת?</h3>
  <p class="small muted m0">המייל של החנות: <bdi class="ltr">${esc(st.from)}</bdi></p>
  ${form(`<div class="choices mt12">${PROVIDERS.map(choice).join('')}</div>`, { do: 'pick' })}
  ${form(`<button class="linkbtn small" type="submit">זה לא המייל של החנות</button>`, { do: 'forget' }, 'mt12')}
  </section>`;
  }

  if (st.step === 'confirm') {
    const c = st.confirm!;
    const codeBox = c.code ? `<div class="copybox mt12"><code class="ltr big" id="code-${id}">${esc(c.code)}</code><button class="btn${c.link ? '' : ' primary'}" type="button" data-copy="#code-${id}" data-done="הקוד הועתק">${icon('copy')}להעתיק</button></div>` : '';
    // Pressing the link is Google's own way ("לוחצים על קישור האימות"). Pasting the code in Gmail's settings is in
    // guides only, and the Hebrew name of its button ("אימות") is UNVERIFIED, so the code is folded under the link.
    const first = c.link
      ? `<li><b>מאשרים את ההעברה</b><span>הכפתור פותח את הדף של Gmail, ושם מאשרים.</span><div class="mt8"><a class="btn primary big" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${icon('check')}ללחוץ כאן לאישור</a></div>${c.code ? `<details class="mt12"><summary class="small">הכפתור לא עובד? יש גם קוד</summary><p class="small mt8 m0">מדביקים אותו ב-Gmail, בתיבה שליד הכתובת של תורן, ולוחצים "אימות".</p>${codeBox}</details>` : ''}</li>`
      : `<li><b>מדביקים את הקוד ב-Gmail</b><span>בתיבה שליד הכתובת של תורן, ולוחצים "אימות".</span>${codeBox}</li>`;
    return `${head}${stepTag(STEP_OF.confirm)}<h3 class="q1">מייל האישור מ-Gmail הגיע</h3>
  <ol class="steps mt12">${first}<li><b>חוזרים ל-Gmail ומרעננים את הדף</b><span>מסמנים "העברת עותק של הודעות נכנסות אל", ולוחצים למטה "שמירת השינויים".</span></li></ol>
  ${ro ? '' : form(`<button class="btn mt16" type="submit">${icon('check')}סיימתי</button>`, { do: 'done' })}
  ${again}</section>`;
  }

  // forward: Gmail goes on by itself once its mail comes; the others say they are done.
  const steps = forwardSteps(st, id, storeName);
  const done = ro ? '' : st.provider === 'gmail' ? form(`<button class="linkbtn small" type="submit">כבר אישרתי ב-Gmail</button>`, { do: 'done' }, 'mt12') : form(`<button class="btn mt16" type="submit">${icon('check')}סיימתי</button>`, { do: 'done' });
  return `${head}${stepTag(STEP_OF.forward)}<h3 class="q1">מעבירים את המייל של החנות לתורן</h3>
  <p class="small muted m0">${esc(PROVIDER_HE[st.provider!])}${st.from ? ` · <bdi class="ltr">${esc(st.from)}</bdi>` : ''}</p>
  ${steps}${done}${again}</section>`;
}

// ---- The routes

export function mailSetupRoutes(app: App): Route<DashReq>[] {
  const ready = () => {
    if (!enabledChannels(app.env).has('email') || !app.mail) throw new ActionError('המייל עוד כבוי בשרת (TORAN_CHANNELS).');
  };
  const back = (r: DashReq, id: number) => (r.ctx.operator ? `/lead/${id}#channels` : '/settings#email');
  return [
    // Where the card stands, for the card waiting on Gmail's code: it loads itself again when this changes.
    ['GET', /^\/lead\/(\d+)\/mail\/state\.json$/, async (_r, m) => ({ json: { v: (await mailState(app, Number(m[1]))).step }, headers: { 'cache-control': 'no-store' } })],
    ['POST', /^\/lead\/(\d+)\/mail\/setup$/, async (r, m) => {
      ready();
      const id = Number(m[1]);
      const what = String(r.form.do || '');
      if (what === 'from') {
        const from = String(r.form.from || '').trim().toLowerCase();
        if (!/^[^\s@<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(from) || from.length > 120) throw new ActionError('זו לא נראית כמו כתובת מייל. למשל shop@gmail.com.');
        if (from.endsWith(`@${app.mail!.domain}`)) throw new ActionError('זו הכתובת של תורן. כותבים כאן את המייל שלקוחות כותבים אליו.');
        const p = await providerOf(from);
        // A known provider goes straight to its steps; anything else is asked, with the address now known.
        await connectEmail(app, id, { from, ...(p === 'gmail' || p === 'outlook' ? { provider: p } : {}) }, r.user.name);
        await audit(app.db, { actor: r.user.name, action: 'email_setup', storeId: id, detail: { from, provider: p } });
        return { redirect: back(r, id), message: p === 'gmail' || p === 'outlook' ? `נראה שזה ${PROVIDER_HE[p]}. עכשיו מעבירים את המייל לתורן.` : 'עכשיו בוחרים באיזה מייל החנות משתמשת.' };
      }
      if (what === 'pick') {
        const p = String(r.form.provider || '') as Provider;
        if (!PROVIDERS.includes(p)) throw new ActionError('אין בחירה כזו', 404);
        const st = await mailState(app, id);
        await connectEmail(app, id, { provider: p, ...(st.from ? { from: st.from } : {}) }, r.user.name);
        await audit(app.db, { actor: r.user.name, action: 'email_setup', storeId: id, detail: { provider: p } });
        return { redirect: back(r, id), message: 'עכשיו מעבירים את המייל לתורן.' };
      }
      const a = await app.db.one<{ id: number }>("SELECT id FROM channel_accounts WHERE store_id = $1 AND channel = 'email' ORDER BY id DESC LIMIT 1", [id]);
      if (what === 'forget') {
        // The address read from the site is not the store's mail: asked again, typed this time.
        if (a) await app.db.query("UPDATE channel_accounts SET meta = (meta - 'provider') || $2::jsonb WHERE id = $1", [a.id, J({ from: '' })]);
        else await connectEmail(app, id, { from: '' }, r.user.name);
        return { redirect: back(r, id), message: 'אפשר לכתוב את המייל של החנות.' };
      }
      if (!a) throw new ActionError('קודם בוחרים באיזה מייל החנות משתמשת.');
      if (what === 'done') {
        await app.db.query("UPDATE channel_accounts SET meta = meta || $2::jsonb WHERE id = $1", [a.id, J({ done_at: new Date().toISOString() })]);
        await audit(app.db, { actor: r.user.name, action: 'email_setup_done', storeId: id });
        return { redirect: back(r, id), message: 'המייל מחובר. מייל של לקוח יגיע לתורן, והוא יענה בשם החנות.' };
      }
      if (what === 'change') {
        await app.db.query("UPDATE channel_accounts SET meta = meta - 'provider' - 'done_at' WHERE id = $1", [a.id]);
        await audit(app.db, { actor: r.user.name, action: 'email_setup_again', storeId: id });
        return { redirect: back(r, id), message: 'מתחילים מחדש.' };
      }
      throw new ActionError('אין פעולה כזו', 404);
    }],
  ];
}
