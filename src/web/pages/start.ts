import type { App } from '../../app.ts';
import { audit } from '../../db/log.ts';
import { enqueue } from '../../jobs/queue.ts';
import { canonicalDomain, homeUrl } from '../../core/urls.ts';
import { INGESTIBLE_HE, canIngest } from '../../ingest/catalogue.ts';
import { ofWhatsapp } from '../../offer.ts';
import { setupStoreOf, storeState } from '../../setup.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, layout } from '../ui.ts';
import { notFoundPage } from './basic.ts';
import { FIELDS, STEPS } from './orders.ts';
import { checkClaim, checkCode, claimFor, CODE_MINUTES, codeLive, hostedDns, keyPlatform, mailReady, mask, META, pendingClaim, ProofError, proveByKey, proven, sendCode, siteOf, takeOrderKey, TXT_HOST, type Claim, type Site, type SitePlatform } from '../../domainProof.ts';

// /start: a new customer adds their store. The public sign-up is accounts' (accounts.openfrequency.co.il), and so is
// its /setup checklist, whose first step for Toran links here (src/setup.ts). One field, the site's address, and the
// store is read as the operator's "add by URL" reads a lead (jobs/worker.ts add_store), with the workspace in the
// job, so the store is born in the workspace and never enters the operator's queues (workspace.ts selling).
//
// POST /start, in order:
//   - an address that is a website: http or https, a host name with a dot, not an IP, localhost or a local name
//   - the workspace has a store already: sent to Today, nothing added (a workspace has one store for now)
//   - its site is being read already: the same
//   - the domain is another workspace's store: refused politely, we look at it with them
//   - the site is not yet proven this workspace's (domainProof.ts, PRA-SEC-003): a claim with a token is kept and the
//     page says how to prove it, the easiest way for what the site is built on first (verifyPage); each way's POST
//     goes on from here once the site is proven:
//       /start/verify         looks for the meta tag or the TXT record
//       /start/verify/key     the store's Shopify or WooCommerce key (the account's owner only)
//       /start/verify/email   sends a code to an address on the site; /start/verify/code checks it
//   - one add a minute per workspace (the audit's start_store), so a held-down button reads one site
//   - the domain is an operator's lead (no workspace): it becomes this workspace's, and its site is read again
//   - otherwise add_store with the workspace id; a live add of the same domain by anyone else waits its turn
// Then Today, which says the site is being read and reloads itself when the job ends (customer.ts setupPage).
//
// Only a customer of a workspace, outside view-as: the operator adds stores from /leads (this is 404 for them), and
// a read-only session's POST is refused in server.ts before it gets here.

const RATE_SECONDS = 60;
/** One look for the proof every few seconds per workspace: each look reads DNS and the home page. */
const VERIFY_SECONDS = 10;

/** A store's address as a customer types it ("store.co.il", "https://www.store.co.il/shop"), or null. */
export function startUrl(input: string): { url: string; domain: string } | null {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  // The URL parser writes every IPv4 form as dotted digits (0x7f.1 is 127.0.0.1) and IPv6 in brackets.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || /[[\]:]/.test(host)) return null;
  if (/(^|\.)(localhost|local|localdomain|internal|lan|intranet|corp|home\.arpa|arpa|test|invalid|onion)$/.test(host)) return null;
  const url = homeUrl(u.toString());
  const domain = url ? canonicalDomain(url) : null;
  return url && domain ? { url, domain } : null;
}

const may = (r: DashReq) => !r.scope.operator && !r.ctx.readOnly && Number(r.scope.workspaceId) > 0;

async function page(app: App, r: DashReq, failed: boolean) {
  const n = ofWhatsapp(app.env);
  const writeUs = n ? ` <a href="https://wa.me/${esc(n)}" target="_blank" rel="noopener">כתבו לנו</a>.` : '';
  const body = `<div class="head"><h1>מוסיפים את החנות</h1><p class="sub">כותבים את הכתובת של האתר, ותורן קורא ממנו את המוצרים, המחירים ודפי המדיניות. זה לוקח דקה או שתיים.</p></div>
${failed ? `<div class="banner warn">${icon('alert')}<div><b>לא הצלחנו לקרוא את האתר הקודם</b><p>כדאי לבדוק שהכתובת נכונה ולנסות שוב.${writeUs}</p></div></div>` : ''}
<form class="panel" method="post" action="/start">${csrfField(r.ctx)}
  <label class="f">הכתובת של האתר<input type="text" name="url" required maxlength="300" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" dir="ltr" placeholder="store.co.il" autofocus></label>
  <button class="btn primary mt12" type="submit">${icon('plus')}לקרוא את האתר</button>
  <p class="small muted mt12 m0">כרגע תורן קורא חנויות ${esc(INGESTIBLE_HE)}. האתר שלכם על פלטפורמה אחרת?${writeUs || ' כתבו לנו.'}</p>
</form>`;
  return layout({ ...r.ctx, title: 'מוסיפים את החנות', active: 'today' }, body);
}

// Where the tag goes on each builder, as each one's own help says it (checked 2026-11-09):
//   Wix        Settings in the site's dashboard > Custom Code, in the Development & integrations section > + Add Custom
//              Code, paste, a name, Add Code to Pages: All pages, Place Code in: Head > Apply; "your site must be
//              published and have a connected domain" (support.wix.com/en/article/wix-editor-embedding-custom-code-on-your-site)
//   WordPress  the WPCode plugin (its plugin page calls it "Insert Headers and Footers" too): Code Snippets > Header &
//              Footer, the Header box, "printed in the <head> section of every page", Save Changes at the top right
//              (wpcode.com/docs/using-the-global-header-footer-settings/)
//   Shopify    Online Store > ... > Edit code, Save (help.shopify.com/en/manual/online-store/themes/customizing-themes/
//              edit-code/edit-theme-code); theme.liquid is "the default layout file, which must be included in all
//              themes", with the <head> (shopify.dev/docs/storefronts/themes/architecture/layouts). That the editor shows
//              it in a folder named Layout is UNVERIFIED in either page's words
//   Webflow    Site settings > Custom code > Head code > Save changes, and the site published again (help.webflow.com/
//              site-settings/custom-code, read through a search: the page itself did not open from here). Which Webflow
//              plans allow custom code is UNVERIFIED
// A builder's help changes its words now and then: the steps say where to look, not every click.
type Builder = { key: string; name: string; steps: string[]; note?: string };
const BUILDERS: Builder[] = [
  { key: 'html', name: 'אתר שנבנה בקוד', steps: ['פותחים את הקובץ של דף הבית, בדרך כלל index.html.', 'מדביקים את השורה בתוך ה-head, למשל ממש לפני </head>.', 'שומרים ומעלים את הקובץ לאתר.'] },
  { key: 'wordpress', name: 'WordPress', steps: ['בניהול של וורדפרס נכנסים לתוספים, מוסיפים תוסף ומתקינים את WPCode. בחיפוש הוא מופיע גם בשם Insert Headers and Footers.', 'מפעילים אותו, ונכנסים בתפריט ל-Code Snippets ואז ל-Header & Footer.', 'מדביקים את השורה בתיבה Header.', 'לוחצים Save Changes למעלה.'] },
  { key: 'wix', name: 'Wix', steps: ['בדשבורד של האתר נכנסים ל-Settings, ובחלק Development & integrations לוחצים Custom Code.', 'לוחצים Add Custom Code למעלה, ומדביקים את השורה בתיבה.', 'נותנים לה שם, למשל תורן, ובוחרים All pages.', 'ב-Place Code in בוחרים Head, ולוחצים Apply.'], note: 'ב-Wix זה עובד רק באתר שפורסם ומחובר לדומיין משלכם.' },
  { key: 'shopify', name: 'Shopify', steps: ['בניהול של Shopify נכנסים ל-Online Store.', 'ליד התבנית לוחצים על שלוש הנקודות, ואז Edit code.', 'פותחים את הקובץ theme.liquid, בתיקייה Layout.', 'מדביקים את השורה ממש לפני </head>, ולוחצים Save.'] },
  { key: 'webflow', name: 'Webflow', steps: ['בפרויקט נכנסים ל-Site settings, ללשונית Custom code.', 'מדביקים את השורה בתיבה Head code, ולוחצים Save changes.', 'מפרסמים את האתר שוב (Publish). בלי זה השורה לא מופיעה באתר.'] },
];
const BUILDER_OF: Record<SitePlatform, string> = { shopify: 'shopify', woocommerce: 'wordpress', wordpress: 'wordpress', wix: 'wix', webflow: 'webflow', other: 'html' };
const PLATFORM_NAME: Partial<Record<SitePlatform, string>> = { shopify: 'Shopify', woocommerce: 'WooCommerce' };

/** A line to copy, with its button. */
const copyRow = (id: string, text: string, done: string) => `<div class="row mt8"><code class="snippet ltr" id="${id}">${esc(text)}</code><button class="btn sm" type="button" data-copy="#${id}" data-done="${esc(done)}">${icon('copy')}להעתיק</button></div>`;

/**
 * The page that says how to prove the site is theirs (domainProof.ts). One way is the main card with the one primary
 * button, picked by what the site is built on (the owner, 2026-11-09: "a native website can have the html tag, others
 * should have an easier way. either way, a tutorial for setting up the tag"):
 *   a code already sent    typing it
 *   Shopify, WooCommerce   connecting the store with its key (the account's owner: a member has no key form)
 *   an address on the site a code to it
 *   anything else          the tag, with steps for each builder, the site's own first and open
 * The others are under "עוד דרכים": the ones left of those, sending the tag to whoever built the site on WhatsApp, and
 * the TXT record when the domain's DNS is the owner's own (hostedDns).
 */
function verifyPage(app: App, r: DashReq, claim: Claim, site: Site) {
  const n = ofWhatsapp(app.env);
  const writeUs = n ? ` <a href="https://wa.me/${esc(n)}" target="_blank" rel="noopener">כתבו לנו</a> ונעזור.` : ' כתבו לנו ונעזור.';
  const value = `${META}=${claim.token}`;
  const tag = `<meta name="${META}" content="${claim.token}">`;
  const domain = `<bdi dir="ltr">${esc(claim.domain)}</bdi>`;
  const csrf = csrfField(r.ctx);
  const owner = r.user.role !== 'client_member';
  const keyWay = owner && keyPlatform(site.platform);
  const emailWay = mailReady(app) && site.emails.length > 0;
  const live = codeLive(claim);
  const main = live ? 'code' : keyWay ? 'key' : emailWay ? 'email' : 'tag';
  const h = (isMain: boolean, text: string) => (isMain ? `<header><h2>${text}</h2></header>` : `<h3 class="mt24">${text}</h3>`);
  const btn = (isMain: boolean) => (isMain ? 'btn primary' : 'btn sm');
  const check = (isMain: boolean) => `<form method="post" action="/start/verify" class="mt12">${csrf}<button class="${btn(isMain)}" type="submit">${icon('refresh')}לבדוק עכשיו</button></form>`;

  const keyCard = (isMain: boolean) => {
    const p = site.platform as 'shopify' | 'woocommerce';
    return `${h(isMain, `מחברים את החנות ב-${PLATFORM_NAME[p]}`)}
  <p class="m0">ככה רואים שהחנות שלכם, ותורן גם יוכל לענות ללקוחות איפה ההזמנה שלהם. צריך מפתח שרק קורא הזמנות.</p>
  <h3 class="small mt16">איך יוצרים את המפתח</h3><ol class="m0">${STEPS[p].map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  <form method="post" action="/start/verify/key" class="mt8">${csrf}${FIELDS[p]}<button class="${btn(isMain)} mt12" type="submit">${icon('check')}לחבר את החנות</button></form>
  <p class="small muted mt8 m0">תורן בודק שהמפתח עובד ושהוא של החנות הזאת. אנחנו שומרים אותו מוצפן, ותורן רק קורא איתו.</p>`;
  };

  const emailCard = (isMain: boolean) => {
    const pick = site.emails.length > 1
      ? `<p class="m0">באתר מופיעות כמה כתובות מייל. בוחרים אחת, ושולחים אליה קוד של 6 ספרות.</p>${site.emails.map((e, i) => `<label class="row mt8"><input type="radio" name="to" value="${i}"${i === 0 ? ' checked' : ''}> <bdi dir="ltr">${esc(mask(e))}</bdi></label>`).join('')}`
      : `<p class="m0">באתר מופיעה הכתובת <bdi dir="ltr">${esc(mask(site.emails[0]))}</bdi>. שולחים אליה קוד של 6 ספרות, ומקלידים אותו כאן.</p><input type="hidden" name="to" value="0">`;
    return `${h(isMain, 'שולחים קוד למייל שמופיע באתר')}
  <form method="post" action="/start/verify/email">${csrf}${pick}<button class="${btn(isMain)} mt12" type="submit">${icon('mail')}לשלוח קוד</button></form>`;
  };

  const codeCard = () => {
    const again = site.emails.indexOf(String(claim.code_to || ''));
    return `${h(true, 'מקלידים את הקוד מהמייל')}
  <p class="m0">שלחנו קוד ל-<bdi dir="ltr">${esc(mask(String(claim.code_to || '')))}</bdi>. הוא בתוקף ${CODE_MINUTES} דקות. לא הגיע? כדאי להציץ גם בספאם.</p>
  <form method="post" action="/start/verify/code" class="mt12">${csrf}<label class="f">הקוד<input type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" dir="ltr" placeholder="123456" autofocus></label><button class="btn primary mt12" type="submit">${icon('check')}לאמת</button></form>
  ${again >= 0 ? `<form method="post" action="/start/verify/email" class="mt8">${csrf}<input type="hidden" name="to" value="${again}"><button class="btn sm ghost" type="submit">לשלוח קוד חדש</button></form>` : ''}`;
  };

  const tagCard = (isMain: boolean) => {
    const first = BUILDER_OF[site.platform] || 'html';
    const list = [...BUILDERS.filter((b) => b.key === first), ...BUILDERS.filter((b) => b.key !== first)];
    return `${h(isMain, 'מוסיפים שורה קטנה לאתר')}
  <p class="m0">מעתיקים את השורה הזאת ומדביקים אותה בתוך ה-head של דף הבית. מי שנכנס לאתר לא רואה אותה.</p>
  ${copyRow('verify-tag', tag, 'השורה הועתקה')}
  <h3 class="small mt16">איפה מדביקים אותה</h3>
  ${list.map((b) => `<details class="mt8"${b.key === first ? ' open' : ''}><summary><b>${esc(b.name)}</b></summary><ol class="m0 mt8">${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>${b.note ? `<p class="small muted mt8 m0">${esc(b.note)}</p>` : ''}</details>`).join('')}
  ${check(isMain)}`;
  };

  // A link that opens WhatsApp with the message written (faq.whatsapp.com/5913398998672934: wa.me/?text=<urlencoded>).
  const ask = `היי, אפשר להוסיף לאתר ${claim.domain} את השורה הזאת בתוך ה-head של דף הבית? היא בשביל לחבר את האתר לתורן.\n\n${tag}\n\nתודה`;
  const builderCard = () => `${h(false, 'מי שבנה לכם את האתר יכול להוסיף אותה')}
  <p class="small m0">שולחים לו בוואטסאפ את השורה עם הסבר קצר. כשהוא מסיים, חוזרים לכאן ולוחצים "לבדוק עכשיו".</p>
  <div class="row mt8"><a class="btn sm" href="https://wa.me/?text=${encodeURIComponent(ask)}" target="_blank" rel="noopener">${icon('chat')}לשלוח בוואטסאפ</a></div>`;

  const txtCard = () => `${h(false, 'רשומת TXT בדומיין')}
  <p class="small m0">מי שמנהל את הדומיין מוסיף בהגדרות ה-DNS רשומת TXT עם הערך הזה, על ${domain} או על <bdi dir="ltr">${esc(`${TXT_HOST}.${claim.domain}`)}</bdi>. רשומה חדשה לפעמים מופיעה רק אחרי כמה דקות.</p>
  ${copyRow('verify-txt', value, 'הערך הועתק')}
  ${check(false)}`;

  const top = main === 'code' ? codeCard() : main === 'key' ? keyCard(true) : main === 'email' ? emailCard(true) : tagCard(true);
  const more = [
    keyWay && main !== 'key' ? keyCard(false) : '',
    emailWay && main !== 'email' && main !== 'code' ? emailCard(false) : '',
    main !== 'tag' ? tagCard(false) : '',
    builderCard(),
    hostedDns(claim) ? '' : txtCard(),
  ].filter(Boolean);
  const lookedFor = claim.checked_at && !live ? `<div class="banner warn">${icon('alert')}<div><b>עוד לא מצאנו את השורה</b><p>אם הוספתם אותה עכשיו, כדאי לחכות כמה דקות ולבדוק שוב. רשומת DNS חדשה לפעמים מופיעה רק אחרי זמן מה.</p></div></div>` : '';
  const body = `<div class="head"><h1>מאמתים שהאתר שלכם</h1><p class="sub">לפני שתורן קורא את ${domain} ועונה בשמו, צריך לוודא שהאתר באמת שלכם. דרך אחת מספיקה.</p></div>
${lookedFor}
<section class="panel verify-main">${top}</section>
<details class="panel mt16 verify-more"><summary><h2>עוד דרכים</h2></summary>${more.join('\n')}</details>
<p class="small muted mt16">אחרי שהאתר מאומת, תורן קורא ממנו את המוצרים ואת דפי המדיניות. משהו לא מסתדר?${writeUs}</p>
<form class="panel" method="post" action="/start">${csrf}
  <label class="f">כתבתם כתובת לא נכונה? אפשר לכתוב אחרת<input type="text" name="url" required maxlength="300" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" dir="ltr" placeholder="store.co.il"></label>
  <button class="btn mt12" type="submit">להחליף כתובת</button>
</form>`;
  return layout({ ...r.ctx, title: 'מאמתים את האתר', active: 'today' }, body);
}

/** A domain this workspace proved: the store is read as before (or the operator's lead becomes the workspace's). */
async function addStore(app: App, r: DashReq, ws: number, site: { url: string; domain: string }) {
  const existing = await app.db.one<{ id: number; platform: string; workspace_id: number | null }>('SELECT id, platform, workspace_id FROM stores WHERE domain = $1', [site.domain]);
  if (existing && existing.workspace_id != null && existing.workspace_id !== ws) throw new ActionError('החנות הזאת כבר מחוברת לחשבון אחר. כתבו לנו ונבדוק.', 409);

  const recent = await app.db.one(`SELECT 1 FROM audit WHERE action = 'start_store' AND detail->>'workspace' = $1 AND at > now() - interval '${RATE_SECONDS} seconds' LIMIT 1`, [String(ws)]);
  if (recent) throw new ActionError('כבר הוספתם כתובת לפני רגע. אפשר לנסות שוב בעוד דקה.', 429);

  if (existing) {
    // A lead the operator found: from now on the customer's own store. The guard on workspace_id keeps a second
    // workspace that asked at the same moment from taking it too.
    const mine = await app.db.one('UPDATE stores SET workspace_id = $2, updated_at = now() WHERE id = $1 AND workspace_id IS NULL RETURNING id', [existing.id, ws]);
    if (!mine) throw new ActionError('החנות הזאת כבר מחוברת לחשבון אחר. כתבו לנו ונבדוק.', 409);
    // The key that proved the site is the store's order key now (a new store gets it in the worker's add_store).
    await takeOrderKey(app, existing.id, r.user.name);
    if (canIngest(existing.platform)) await enqueue(app.db, 'ingest', { storeId: existing.id }, { dedupeKey: `ingest:${existing.id}` });
    await audit(app.db, { actor: r.user.name, action: 'start_store', storeId: existing.id, detail: { workspace: ws, url: site.url, lead: true } });
    return { redirect: '/', message: 'קוראים את האתר שלכם. זה לוקח דקה או שתיים.' };
  }

  // Someone else is adding the same domain right now (the operator, a demo asked for on the website): its job
  // would be the one the dedupe key returns, without this workspace, so this one waits for it to end.
  const other = await app.db.one<{ payload: any }>("SELECT payload FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running')", [`add:${site.domain}`]);
  if (other && Number(other.payload?.workspaceId) !== ws) throw new ActionError('את האתר הזה קוראים עכשיו. אפשר לנסות שוב בעוד כמה דקות.', 409);
  // A domain looked at before and passed over (discovery's verdicts) is looked at again: the owner says it is a store.
  await app.db.query('DELETE FROM seen_domains WHERE domain = $1', [site.domain]);
  const job = await enqueue(app.db, 'add_store', { url: site.url, by: r.user.name, workspaceId: ws }, { dedupeKey: `add:${site.domain}`, maxAttempts: 1 });
  await audit(app.db, { actor: r.user.name, action: 'start_store', detail: { workspace: ws, url: site.url, job } });
  return { redirect: '/', message: 'קוראים את האתר שלכם. זה לוקח דקה או שתיים.' };
}

export function startRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/start$/, async (r) => {
      if (r.scope.operator) return { status: 404, html: notFoundPage(r.ctx) };
      if (!may(r)) return { redirect: '/' };
      const found = await setupStoreOf(app, Number(r.scope.workspaceId));
      const st = storeState(found);
      // A store, or one being read: Today is where it shows.
      if (found.store || st.status === 'working') return { redirect: '/' };
      if (found.claim) {
        const site = await siteOf(app, found.claim).catch((e): Site => {
          app.log(`[proof] ${found.claim!.domain}: the site was not read: ${e?.message || e}`);
          return { platform: 'other', emails: [], hosted: hostedDns(found.claim!) };
        });
        return { html: verifyPage(app, r, found.claim, site) };
      }
      return { html: await page(app, r, st.status === 'attention') };
    }],
    ['POST', /^\/start$/, async (r) => {
      if (r.scope.operator) throw new ActionError('לא נמצא', 404);
      if (!may(r)) throw new ActionError('במצב צפייה אי אפשר לשנות כלום.', 403);
      const ws = Number(r.scope.workspaceId);
      const site = startUrl(r.form.url || '');
      if (!site) throw new ActionError('זו לא כתובת של אתר. כותבים אותה כמו בדפדפן, למשל store.co.il');
      const found = await setupStoreOf(app, ws);
      if (found.store) return { redirect: '/', message: 'החנות שלכם כבר מחוברת.' };
      if (storeState(found).status === 'working') return { redirect: '/', message: 'כבר קוראים את האתר שלכם. זה לוקח דקה או שתיים.' };
      const taken = await app.db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE domain = $1', [site.domain]);
      if (taken && taken.workspace_id != null && taken.workspace_id !== ws) throw new ActionError('החנות הזאת כבר מחוברת לחשבון אחר. כתבו לנו ונבדוק.', 409);
      // Nothing is read or moved before the site is proven this workspace's (domainProof.ts). A newer address replaces
      // the claim waiting before it.
      if (!(await proven(app, ws, site.domain))) {
        await app.db.query('DELETE FROM domain_claims WHERE workspace_id = $1 AND proven_at IS NULL AND domain <> $2', [ws, site.domain]);
        await claimFor(app, ws, site.domain, site.url);
        await audit(app.db, { actor: r.user.name, action: 'claim_domain', detail: { workspace: ws, domain: site.domain } });
        return { redirect: '/start', message: 'עוד צעד אחד: לאמת שהאתר שלכם.' };
      }
      return addStore(app, r, ws, site);
    }],
    ['POST', /^\/start\/verify$/, async (r) => {
      const { ws, claim } = await verifying(r);
      if (!claim) return { redirect: '/' };
      await oneLook(ws);
      const res = await checkClaim(app, claim);
      await audit(app.db, { actor: r.user.name, action: 'verify_domain', detail: { workspace: ws, domain: claim.domain, ok: res.ok, how: res.how, why: res.why } });
      if (!res.ok) throw new ActionError('עוד לא מצאנו את השורה באתר או את הרשומה ב-DNS. אם הוספתם אותה עכשיו, כדאי לחכות כמה דקות ולבדוק שוב.', 422);
      return addStore(app, r, ws, { url: claim.url, domain: claim.domain });
    }],
    // The store's own key: only the account's owner holds the store's keys (as on the orders panel, pages/orders.ts).
    ['POST', /^\/start\/verify\/key$/, async (r) => {
      const { ws, claim } = await verifying(r);
      if (r.user.role === 'client_member') throw new ActionError('את החנות מחבר מי שפתח את החשבון.', 403);
      if (!claim) return { redirect: '/' };
      await oneLook(ws);
      try {
        const res = await proveByKey(app, claim, r.form);
        await audit(app.db, { actor: r.user.name, action: 'verify_domain', detail: { workspace: ws, domain: claim.domain, ok: true, how: res.how } });
      } catch (e) {
        if (!(e instanceof ProofError)) throw e;
        await audit(app.db, { actor: r.user.name, action: 'verify_domain', detail: { workspace: ws, domain: claim.domain, ok: false, how: 'key', why: e.message.slice(0, 200) } });
        throw new ActionError(e.he, e.status);
      }
      return addStore(app, r, ws, { url: claim.url, domain: claim.domain });
    }],
    // A code to one of the addresses the site publishes, picked by its place in the list the page showed.
    ['POST', /^\/start\/verify\/email$/, async (r) => {
      const { claim } = await verifying(r);
      if (!claim) return { redirect: '/' };
      const site = await siteOf(app, claim);
      const to = site.emails[Number.parseInt(String(r.form.to ?? '0'), 10) || 0];
      if (!to) throw new ActionError('לא מצאנו באתר כתובת מייל. אפשר לבחור דרך אחרת.', 422);
      try {
        await sendCode(app, claim, to, r.user.name);
      } catch (e) {
        if (e instanceof ProofError) throw new ActionError(e.he, e.status);
        throw e;
      }
      return { redirect: '/start', message: `שלחנו קוד ל-${mask(to)}.` };
    }],
    ['POST', /^\/start\/verify\/code$/, async (r) => {
      const { ws, claim } = await verifying(r);
      if (!claim) return { redirect: '/' };
      try {
        await checkCode(app, claim, String(r.form.code || ''));
      } catch (e) {
        if (e instanceof ProofError) throw new ActionError(e.he, e.status);
        throw e;
      }
      await audit(app.db, { actor: r.user.name, action: 'verify_domain', detail: { workspace: ws, domain: claim.domain, ok: true, how: 'email' } });
      return addStore(app, r, ws, { url: claim.url, domain: claim.domain });
    }],
  ];

  /** The customer's workspace and its claim waiting for proof, after the checks every verify POST makes. */
  async function verifying(r: DashReq) {
    if (r.scope.operator) throw new ActionError('לא נמצא', 404);
    if (!may(r)) throw new ActionError('במצב צפייה אי אפשר לשנות כלום.', 403);
    const ws = Number(r.scope.workspaceId);
    return { ws, claim: await pendingClaim(app, ws) };
  }

  /** One look for the tag, the record or a key every few seconds per workspace. */
  async function oneLook(ws: number) {
    const recent = await app.db.one(`SELECT 1 FROM audit WHERE action = 'verify_domain' AND detail->>'workspace' = $1 AND at > now() - interval '${VERIFY_SECONDS} seconds' LIMIT 1`, [String(ws)]);
    if (recent) throw new ActionError('בדקנו לפני רגע. אפשר לבדוק שוב בעוד כמה שניות.', 429);
  }
}
