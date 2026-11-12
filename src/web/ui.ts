import { a11yHead, a11yWidget, toranMark, ofMark, iconLinks } from '../brand.ts';
import { themeButton, themeHead, themeMeta } from './theme.ts';
import { prefixed } from '../core/hebrew.ts';
import type { InstallCtx } from './install.ts';

// The pieces every page is made of. Pages are functions from data to HTML strings: no
// framework, so a page can be tested by reading it. Every value that came from outside
// goes through esc(). Ported from Teder's src/web/ui.js.
//
// The document is lang="he" dir="rtl". A Latin run inside Hebrew (a domain, a URL, a
// product name) sits in <bdi> or .ltr so bidi cannot scramble the punctuation around it.

export const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const TZ = 'Asia/Jerusalem';
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, ...o });
const F = {
  day: fmt({ weekday: 'long', day: 'numeric', month: 'long' }),
  short: fmt({ day: 'numeric', month: 'short' }),
  time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
  stamp: fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
};
const d = (t: unknown) => new Date(t as string);
export const dayHe = (t: unknown) => F.day.format(d(t));
export const shortDate = (t: unknown) => (t ? F.short.format(d(t)) : '');
export const timeHe = (t: unknown) => (t ? F.time.format(d(t)) : '');
export const stamp = (t: unknown) => (t ? F.stamp.format(d(t)) : '');
const W = fmt({ weekday: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }); // 2026-11-08
/** How many calendar days (in Israel) lie between a time and now: 0 today, 1 yesterday. */
export const daysAgo = (t: unknown, now = Date.now()) => Math.round((Date.parse(dayKey.format(now)) - Date.parse(dayKey.format(d(t)))) / 86_400_000);
/** A time in a list, as a mail client writes it: 14:32 today, אתמול, the weekday this week, then the date. */
export function listTime(t: unknown, now = Date.now()): string {
  if (!t) return '';
  const n = daysAgo(t, now);
  return n <= 0 ? timeHe(t) : n === 1 ? 'אתמול' : n < 7 ? W.format(d(t)) : shortDate(t);
}
/** A day's line in a conversation: היום, אתמול, or the day itself. */
export function dayLine(t: unknown, now = Date.now()): string {
  const n = daysAgo(t, now);
  return n <= 0 ? 'היום' : n === 1 ? 'אתמול' : dayHe(t);
}

/** "לפני 3 שעות", for the lists. */
export function ago(t: unknown, now = Date.now()): string {
  if (!t) return '';
  const s = Math.max(0, (now - d(t).getTime()) / 1000);
  if (s < 90) return 'עכשיו';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return Math.round(s / 3600) === 1 ? 'לפני שעה' : `לפני ${Math.round(s / 3600)} שעות`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'אתמול' : days < 14 ? `לפני ${days} ימים` : shortDate(t);
}

// The owner reads tokens, never dollars: a dollar of spend is 100 tokens (Teder's rule). Developer mode adds the dollars.
export const TOKENS_PER_USD = 100;
export const tokenNum = (usd: unknown) => Math.round((Number(usd) || 0) * TOKENS_PER_USD).toLocaleString('en-US');
export const tok = (usd: unknown) => `<span class="num">${tokenNum(usd)} טוקנים</span>`;
export const usd = (n: unknown, digits = 2) => `<span class="num ltr">$${(Number(n) || 0).toFixed(digits)}</span>`;

export const icon = (name: string, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/**
 * Each channel's own logo, in its own colours, for the inbox (the owner, 2026-11-11: "make the toran inbox look a bit
 * more like an inbox, maybe mark every type of channel with its logo"): WhatsApp's green bubble and handset, Messenger's
 * bubble and bolt, Instagram's camera on its gradient, an envelope for mail and a speech bubble for the chat on the
 * store's site. Simple glyphs drawn here, on the icons' 24-unit square, filled rather than stroked, so a logo reads at
 * 16px. The site chat is the ink of the chat itself (static/chat.css, #2c2c30): its bubble takes the colour and its dots
 * the fill the stylesheet gives .chl-web, so it turns over in dark. inbox.ts channelLogo draws them.
 */
const CHANNEL_SYMBOLS = `<linearGradient id="chg-ms" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0a7cff"/><stop offset=".6" stop-color="#a033ff"/><stop offset="1" stop-color="#ff5c87"/></linearGradient>
<radialGradient id="chg-ig" cx=".28" cy="1.04" r="1.25"><stop offset="0" stop-color="#ffd86b"/><stop offset=".22" stop-color="#ff8a3d"/><stop offset=".48" stop-color="#ec3a6a"/><stop offset=".74" stop-color="#b52fa3"/><stop offset="1" stop-color="#5a4fdb"/></radialGradient>
<symbol id="ch-whatsapp" viewBox="0 0 24 24"><path fill="#25d366" d="M12 2.2a9.8 9.8 0 0 0-8.5 14.7L2.2 21.8l5.1-1.3A9.8 9.8 0 1 0 12 2.2z"/><path fill="#fff" transform="translate(5.76 5.76) scale(.52)" d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/></symbol>
<symbol id="ch-messenger" viewBox="0 0 24 24"><path fill="url(#chg-ms)" d="M12 2.3c-5.4 0-9.7 4-9.7 9.4 0 2.8 1.2 5.3 3.2 7v3.4l3.2-1.8c1 .3 2.1.5 3.3.5 5.4 0 9.7-4 9.7-9.3S17.4 2.3 12 2.3z"/><path fill="#fff" d="M6.6 14.3l3.7-5 2.9 2.3 4.2-2.2-4.2 4.8-2.9-2.3z"/></symbol>
<symbol id="ch-instagram" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#chg-ig)"/><rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.4" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="15.3" cy="8.7" r=".95" fill="#fff"/></symbol>
<symbol id="ch-email" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5.5" fill="#2f7de1"/><rect x="5.8" y="7.3" width="12.4" height="9.4" rx="1.6" fill="#fff"/><path d="M6.5 8.3l5.5 4.2 5.5-4.2" fill="none" stroke="#2f7de1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="ch-web" viewBox="0 0 24 24"><path fill="currentColor" d="M5 3.5h14A2.5 2.5 0 0 1 21.5 6v9a2.5 2.5 0 0 1-2.5 2.5h-7.4l-3.9 3.3a.6.6 0 0 1-1-.5v-2.8H5A2.5 2.5 0 0 1 2.5 15V6A2.5 2.5 0 0 1 5 3.5z"/><circle cx="8" cy="10.5" r="1.3"/><circle cx="12" cy="10.5" r="1.3"/><circle cx="16" cy="10.5" r="1.3"/></symbol>`;

// The icons, drawn on a 24-unit square and each centred in it, so an icon beside a label sits on the label's middle
// (the owner, 2026-11-09: "some buttons are not centered", on "✦ לעוזר": the spark spanned 3 to 17 and sat 2 units
// high, the label looking low beside it; the book reached 23 and sat 1 low). Both are moved to the centre.
const SPRITE = `<svg class="sr" width="0" height="0" aria-hidden="true"><defs>
<symbol id="i-results" viewBox="0 0 24 24"><path d="M6 20V10M12 20V4M18 20v-7M3 20h18"/></symbol>
<symbol id="i-today" viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/></symbol>
<symbol id="i-leads" viewBox="0 0 24 24"><path d="M3 9.5L5 4h14l2 5.5"/><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12.5V20h14v-7.5"/><path d="M10 20v-4h4v4"/></symbol>
<symbol id="i-review" viewBox="0 0 24 24"><path d="M9 4h6M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><path d="M8.5 13l2.5 2.5 4.5-5"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
<symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></symbol>
<symbol id="i-hand" viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-7a1.5 1.5 0 0 1 3 0V12M14 6.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14.5a1.6 1.6 0 0 1 2.6-1.8L8 14"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/></symbol>
<symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></symbol>
<symbol id="i-book" viewBox="0 0 24 24"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 7h7M9 10.5h5"/></symbol>
<symbol id="i-card" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h4"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></symbol>
<symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/></symbol>
<symbol id="i-phone" viewBox="0 0 24 24"><path d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M12 3a9 8.5 0 0 0-5.2 15.4V21l3-1.7A9.6 9.6 0 0 0 12 19.5 9 8.5 0 0 0 12 3z"/><path d="M7.5 13.5l3-3.2 2.2 2 3.8-3.6-3 3.2-2.2-2z"/></symbol>
<symbol id="i-camera" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.8"/><path d="M16.8 7.2h.01"/></symbol>
<symbol id="i-clip" viewBox="0 0 24 24"><path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"/></symbol>
<symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 5l1.9 5.5L19.5 12l-5.6 1.6L12 19l-1.9-5.4L4.5 12l5.6-1.5z"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><path d="M8.5 9H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5"/><path d="M12 3v11M8.5 6.5L12 3l3.5 3.5"/></symbol>
<symbol id="i-dots" viewBox="0 0 24 24"><path stroke-width="3" d="M5.5 12h.01M12 12h.01M18.5 12h.01"/></symbol>
<symbol id="i-kebab" viewBox="0 0 24 24"><path stroke-width="3" d="M12 5.5v.01M12 12v.01M12 18.5v.01"/></symbol>
<symbol id="i-addsq" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></symbol>
<symbol id="i-get" viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/></symbol>
<symbol id="i-install" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8.5 20.5h7M12 7.5v6M9.5 11l2.5 2.5 2.5-2.5"/></symbol>
${CHANNEL_SYMBOLS}
</defs></svg>`;

// The operator's sections, the same in the tab bar (phone) and the sidebar (desk).
export const NAV: [string, string, string, string][] = [
  ['/', 'היום', 'today', 'today'],
  ['/leads', 'לידים', 'leads', 'leads'],
  ['/review', 'לבדיקה', 'review', 'review'],
  ['/chats', 'שיחות', 'chats', 'chat'],
  ['/assistant', 'העוזר', 'assistant', 'spark'],
  ['/followups', 'מעקב', 'followups', 'clock'],
  ['/settings', 'הגדרות', 'settings', 'settings'],
];
// A customer's (a store owner's, and the operator viewing as one): what openfrequency.co.il/toran sells them. The
// inbox, what Toran knows about the store, their assistant, the plan, and the store's channels.
export const CUSTOMER_NAV: [string, string, string, string][] = [
  ['/', 'היום', 'today', 'today'],
  ['/chats', 'שיחות', 'chats', 'chat'],
  ['/knowledge', 'מה הוא יודע', 'knowledge', 'book'],
  ['/assistant', 'העוזר', 'assistant', 'spark'],
  // Results in the plan's place (TORAN-READINESS.md P1-12): the plan is the header's meter and its own page, /plan. Its
  // icon is Teder's results' bars (the owner, 2026-11-10: "Toran and teder dashboards should be consistent").
  ['/results', 'תוצאות', 'results', 'results'],
  ['/settings', 'הגדרות', 'settings', 'settings'],
];
// /plan is Settings' part (its fold "החבילה"), as Teder keeps the plan in Settings (the audit of 2026-11-12, P1-19).
const SECTION_OF: Record<string, string> = { lead: 'leads', add: 'leads', chat: 'chats', brand: 'settings', discover: 'leads', plan: 'settings' };

export type PageCtx = {
  title: string;
  active?: string;
  csrf: string;
  side?: 'mini' | null;
  v?: string;
  waiting?: { review?: number; followups?: number; chats?: number };
  spend?: { usd: number; cap: number };
  flash?: string | null;
  dev?: boolean;
  user?: { name: string; role: string };
  /** The superadmin outside view-as: sees every workspace and the whole server's settings. */
  operator?: boolean;
  /** View-as: the server refuses every POST, and the page hides its buttons. */
  readOnly?: boolean;
  /** Set when the superadmin views a workspace as its customer: the banner on every page (accounts asks for it). */
  viewAs?: { name: string; admin: string } | null;
  /** A page that needs the room, as the inbox's list beside its open conversation. */
  wide?: boolean;
  /** Accounts' sign-out page. */
  logout?: string;
  /** Who is signed in, for Settings' "החשבון" (server.ts, from accounts' session): their address and the workspace's name. */
  account?: { email: string; workspace: string } | null;
  /** A customer's conversations this month against their plans (plans.ts), in the header where the operator sees tokens. */
  plan?: { used: number; cap: number } | null;
  /** The pay reminder (billing/entitlement.ts payReminder) and where to pay: accounts' /setup. */
  pay?: { state: 'soon' | 'due'; until: string } | null;
  payHref?: string | null;
  /** The browser, for adding Toran to the phone (install.ts); null under accounts' /admin, whose site is not Toran's. */
  install?: InstallCtx | null;
  /** The workspace's store, shown in the header as Teder shows the account (routes.ts headerCounts); none for the operator. */
  store?: { id: number; name: string; domain: string; more: number } | null;
  /**
   * Under accounts' /admin/toran, accounts' /admin: not Toran's own site, so nothing offers it as the app on a phone (no
   * manifest), and a line at the top of every page leads back to the admin dashboard.
   */
  admin?: string | null;
};

/**
 * The pay reminder at the top of every page of a customer's workspace, as Teder's (TORAN-READINESS.md P1-3): the last
 * week paid for, calm, and the days of grace after it in the warning's colour, with one way to pay (accounts' /setup).
 */
const PAY_DAY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
const PAY_DATE = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });
/**
 * A part of a page that folds away on a phone, as Teder's fold (TORAN-READINESS.md P1-19; the owner, 2026-11-05, on an
 * iPhone: "too many things jump to the eyes at the same time"): there one row with its name, opened with a tap; from
 * 700px open, and the row is not drawn. static/app.js folds it as a phone opens the page, except the one a link points
 * into and one that was open before the page came back; without the script it stays open. Nothing, for nothing inside.
 */
export const fold = (key: string, label: string, inner: string) => (inner ? `<details class="mfold one" data-mfold="${esc(key)}" open><summary>${esc(label)}</summary>${inner}</details>` : '');

/**
 * The way back to the admin dashboard, on every page of Toran's under accounts' /admin/toran (accounts'
 * docs/admin-split.md): those are every store's pages, and the owner reaches them from there. Its address is accounts'
 * own, absolute, so the prefix never goes in front of it.
 */
export function adminBar(ctx: Pick<PageCtx, 'admin'>): string {
  if (!ctx.admin) return '';
  return `<div class="banner info adminbar" role="note">${icon('shield')}<div><b>כאן רואים את תורן של כל החנויות והלידים.</b></div><a class="btn sm" href="${esc(ctx.admin)}">חזרה ללוח הניהול</a></div>`;
}

export function payBanner(ctx: Pick<PageCtx, 'pay' | 'payHref'>): string {
  const r = ctx.pay;
  if (!r || !ctx.payHref) return '';
  const due = r.state === 'due';
  const when = (due ? PAY_DAY : PAY_DATE).format(new Date(r.until));
  const title = due ? 'החודש ששילמתם עליו נגמר, והתשלום על החודש הבא עוד לא הגיע אלינו.' : `המנוי לתורן שולם עד ${when}.`;
  const text = due ? `תורן ממשיך לענות ללקוחות עד סוף ${when}, ואז ייעצר עד שהתשלום יגיע.` : 'אפשר כבר לשלם על החודש הבא, כדי שתורן ימשיך לענות בלי הפסקה.';
  return `<div class="banner ${due ? 'warn' : 'info'} pay" id="pay">${icon(due ? 'alert' : 'clock')}<div><b>${esc(title)}</b><p>${esc(text)}</p></div><a class="btn sm${due ? ' primary' : ''}" href="${esc(ctx.payHref)}">איך משלמים</a></div>`;
}

/**
 * What makes a page the app a phone keeps (the owner, 2026-11-10, of Toran's mark on a phone): on Toran's own site only.
 * Under accounts' /admin/toran a saved icon would open accounts (the manifest's start_url is the site's root), so those
 * pages offer none; the operator keeps Toran on the phone from Toran's own address, where they see it as its owner
 * sees it, with its mark (accounts' docs/admin-split.md).
 */
const APP_META = `<meta name="apple-mobile-web-app-title" content="תורן">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
`;

/**
 * The store the pages are about, where Teder's header has the account it shows (the owner, 2026-11-10: "Toran and teder
 * dashboards should be consistent"; docs/design-pro.md, "The two desks side by side"): its colour, its name and its
 * address, in the same pill, under the mark on a desk and beside it on a phone. Toran's workspace has one store, so there
 * is nothing to switch to; a second one is counted in the title.
 */
export function storePill(ctx: Pick<PageCtx, 'store' | 'operator'>): string {
  const s = ctx.store;
  if (!s || ctx.operator) return '';
  const title = s.more > 0 ? `${s.name} ועוד ${s.more === 1 ? 'חנות אחת' : `${s.more} חנויות`}` : s.name;
  return `<div class="acctswitch store" title="${esc(title)}"><span class="pill"><span class="ic"><span class="dot st-${Number(s.id)}" aria-hidden="true"></span></span><span class="nm"><b>${esc(s.name)}</b><small class="ltr">${esc(s.domain)}</small></span></span></div>`;
}

export function layout(ctx: PageCtx, body: string): string {
  const section = SECTION_OF[ctx.active || ''] || ctx.active;
  const counts: Record<string, number | undefined> = { review: ctx.waiting?.review, followups: ctx.waiting?.followups, chats: ctx.waiting?.chats };
  const badge = (key: string) => (counts[key] ? `<b class="badge num" aria-label="${counts[key]} מחכים">${counts[key]}</b>` : '');
  const sections = ctx.operator ? NAV : CUSTOMER_NAV;
  const nav = sections.map(([href, label, key, ic]) => `<a href="${href}" title="${label}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  const tabs = sections.map(([href, label, key, ic]) => `<a href="${href}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  const s = ctx.spend || { usd: 0, cap: 0 };
  const cap = Number(s.cap) || 0;
  const spent = Number(s.usd) || 0;
  const ringOf = (used: number) => `<svg class="ring${used >= 90 ? ' bad' : used >= 70 ? ' warn' : ''}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><circle class="v" cx="10" cy="10" r="8" pathLength="100" stroke-dasharray="${used} 100"/></svg>`;
  const ring = ringOf(cap ? Math.min(100, Math.round((spent / cap) * 100)) : 0);
  // The operator reads the server's tokens; a customer reads their conversations against the plan, which is what they pay
  // for, from the first day: a workspace with no store yet reads 0, never the tokens (the owner, 2026-11-10, seeing Toran
  // as a customer does: "regular, just like a customer's").
  const p = ctx.operator ? null : ctx.plan || { used: 0, cap: 0 };
  const meter = !p
    ? `<a class="spend" href="/settings#costs" title="טוקנים החודש: ${tokenNum(spent)}${cap ? ` מתוך ${tokenNum(cap)}` : ''}">${ring}<span class="lbl">טוקנים</span><span class="amt num ltr"><b>${tokenNum(spent)}</b>${cap ? `<span> / ${tokenNum(cap)}</span>` : ''}</span></a>`
    : `<a class="spend" href="/plan" title="שיחות החודש: ${p.used.toLocaleString('en-US')}${p.cap ? ` מתוך ${p.cap.toLocaleString('en-US')} בחבילה` : ''}">${ringOf(p.cap ? Math.min(100, Math.round((p.used / p.cap) * 100)) : 0)}<span class="lbl">שיחות</span><span class="amt num ltr"><b>${p.used.toLocaleString('en-US')}</b>${p.cap ? `<span> / ${p.cap.toLocaleString('en-US')}</span>` : ''}</span></a>`;
  const flash = ctx.flash ? ` data-flash="${esc(ctx.flash)}"` : '';
  return `<!doctype html>
<html lang="he" dir="rtl" data-theme="light"${ctx.side === 'mini' ? ' class="side-mini"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${themeMeta()}
<meta name="robots" content="noindex, nofollow">
${ctx.admin ? '' : APP_META}<title>${esc(ctx.title)} · תורן</title>
<link rel="stylesheet" href="/static/brand.css?v=${ctx.v || 1}">
<link rel="stylesheet" href="/static/style.css?v=${ctx.v || 1}">
<link rel="stylesheet" href="/static/stores.css?v=${ctx.v || 1}">
${a11yHead(ctx.v || 1)}
${themeHead(ctx.v || 1)}
${iconLinks()}
${ctx.admin ? '' : '<link rel="manifest" href="/static/manifest.webmanifest">\n'}</head>
<body${ctx.readOnly ? ' class="ro"' : ''}>
${SPRITE}
${ctx.viewAs ? `<div class="viewas" role="status">${icon('eye')}<span>אתם צופים ${prefixed('ב', esc(ctx.viewAs.name))} כמו שהלקוח רואה אותו. זו צפייה בלבד, ושום שינוי לא נשמר.</span><a href="${esc(ctx.viewAs.admin)}">סיום צפייה</a></div>` : ''}
<header class="top"><div class="wrap">
  <a class="brand" href="/" aria-label="תורן, להיום">${toranMark(34, { label: null })}<b>תורן</b></a>
  ${storePill(ctx)}
  <button class="sidetoggle" type="button" data-side aria-label="${ctx.side === 'mini' ? 'להרחיב את סרגל הצד' : 'לכווץ את סרגל הצד'}" aria-expanded="${ctx.side === 'mini' ? 'false' : 'true'}" title="${ctx.side === 'mini' ? 'להרחיב' : 'לכווץ'}">${icon('sidebar')}</button>
  <nav class="nav" aria-label="ראשי">${nav}</nav>
  <div class="tools">
    ${meter}
    ${themeButton()}
    ${ctx.logout ? `<a class="logout" href="${esc(ctx.logout)}" title="יציאה">${icon('logout')}<span class="lbl">יציאה</span></a>` : ''}
  </div>
</div></header>
<main class="wrap${ctx.wide ? ' wide' : ''}" id="main">
${adminBar(ctx)}${payBanner(ctx)}
${body}
<footer class="foot">${ofMark(28, { label: null })}<span class="ltr">OpenFrequency<sup>™</sup></span></footer>
</main>
<nav class="tabbar" aria-label="ניווט">${tabs}</nav>
<div id="toast" role="status" aria-live="polite"${flash}></div>
${a11yWidget()}
<script src="/static/app.js?v=${ctx.v || 1}" defer></script>
</body>
</html>`;
}

export const csrfField = (ctx: { csrf: string }) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;

/**
 * A ready message for someone else to act on (whoever runs the store's site or mail), on WhatsApp, where the owner
 * picks the contact, or by email. The owner, 2026-11-09: "make everything easy for the user. he also doesnt know
 * anything about tech": the technical words go inside this message, never on the card.
 */
export const sendTo = (text: string, subject: string, label: string, cls = 'btn') => `<div class="row mt12"><a class="${cls}" href="${esc(`https://wa.me/?text=${encodeURIComponent(text)}`)}" target="_blank" rel="noopener">${icon('send')}${esc(label)}</a><a class="btn ghost sm" href="${esc(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`)}">${icon('mail')}או במייל</a></div>`;

/** A small POST form with one button. */
export function postButton(ctx: { csrf: string }, action: string, label: string, { cls = 'btn', ajax = null, confirm = null, fields = {}, title = null, iconName = null }: { cls?: string; ajax?: string | null; confirm?: string | null; fields?: Record<string, unknown>; title?: string | null; iconName?: string | null } = {}) {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<form method="post" action="${esc(action)}"${ajax ? ` data-ajax="${esc(ajax)}"` : ''}>${csrfField(ctx)}${hidden}<button class="${cls}" type="submit"${confirm ? ` data-confirm="${esc(confirm)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${iconName ? icon(iconName) : ''}${label}</button></form>`;
}

// The lead's place in the funnel, in words and the colour that means it.
export const STATUS_HE: Record<string, [string, string]> = {
  new: ['חדש', ''],
  page_ready: ['דף מוכן', 'sig'],
  sent: ['נשלח', 'ok'],
  opened: ['נפתח', 'ok'],
  demo_started: ['התחיל דמו', 'ok'],
  pilot: ['בהקמה', 'ok'],
  paid: ['משלם', 'ok'],
  skipped: ['דילגתי', 'ghost'],
  company: ['השירות שלנו', 'sig'], // a company store: OpenFrequency's own support (src/company.ts)
};
export const STATUS_ORDER = ['new', 'page_ready', 'sent', 'opened', 'demo_started', 'pilot', 'paid', 'skipped'];
export const statusChip = (s: string, approved = false) => {
  if (s === 'page_ready' && approved) return '<span class="chip ok">אושר, מוכן לשליחה</span>';
  const [he, cls] = STATUS_HE[s] || [s, ''];
  return `<span class="chip ${cls}">${esc(he)}</span>`;
};

export const PLATFORM_HE: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix', konimbo: 'Konimbo', cashcow: 'Cashcow', magento: 'Magento', bigcommerce: 'BigCommerce', other: 'פלטפורמה אחרת', unknown: 'לא זוהה', company: 'השירות שלנו' };

/** A store's initial in a circle, in the store's colour (stores.css sets --store per store id). */
export function storeBadge(s: { id: number; name?: string | null; domain: string }, cls = 'initial') {
  const ch = (String(s.name || s.domain).trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
  return `<span class="${cls} st-${Number(s.id)}" aria-hidden="true">${esc(ch)}</span>`;
}

/** The score, coloured by whether it qualifies. */
export const scoreNum = (score: number, qualified: boolean) => `<span class="score ${qualified ? 'ok' : score < 40 ? 'low' : ''}">${Number(score) || 0}</span>`;

/** A bar of 0-10 tenths for a part of the score. */
export const vbar = (points: number, max: number) => `<span class="vbar"><i class="w${max > 0 ? Math.max(0, Math.min(10, Math.round((points / max) * 10))) : 0}"></i></span>`;
