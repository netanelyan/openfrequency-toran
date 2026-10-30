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
import { checkClaim, claimFor, META, pendingClaim, proven, TXT_HOST, type Claim } from '../../domainProof.ts';

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
//     page says how to prove it, a DNS TXT record or a meta tag; POST /start/verify looks, and goes on from here once it is
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

/** The page that says how to prove the site is theirs (domainProof.ts): a TXT record or a meta tag, either one. */
function verifyPage(app: App, r: DashReq, claim: Claim) {
  const n = ofWhatsapp(app.env);
  const writeUs = n ? ` <a href="https://wa.me/${esc(n)}" target="_blank" rel="noopener">כתבו לנו</a> ונעזור.` : ' כתבו לנו ונעזור.';
  const value = `${META}=${claim.token}`;
  const tag = `<meta name="${META}" content="${claim.token}">`;
  const body = `<div class="head"><h1>מאמתים שהאתר שלכם</h1><p class="sub">לפני שתורן קורא את <bdi dir="ltr">${esc(claim.domain)}</bdi> ועונה בשמו, צריך לוודא שהאתר באמת שלכם. אחת משתי הדרכים מספיקה.</p></div>
${claim.checked_at ? `<div class="banner warn">${icon('alert')}<div><b>עוד לא מצאנו את הקוד</b><p>אם הוספתם אותו עכשיו, כדאי לחכות כמה דקות ולבדוק שוב. רשומת DNS חדשה לפעמים מופיעה רק אחרי זמן מה.</p></div></div>` : ''}
<section class="panel"><header><h2>רשומת TXT בדומיין</h2></header>
  <p>בהגדרות ה-DNS של הדומיין מוסיפים רשומת TXT עם הערך הזה, על <bdi dir="ltr">${esc(claim.domain)}</bdi> או על <bdi dir="ltr">${esc(`${TXT_HOST}.${claim.domain}`)}</bdi>:</p>
  <pre dir="ltr" class="code">${esc(value)}</pre>
</section>
<section class="panel"><header><h2>או: תגית בדף הבית</h2></header>
  <p>מדביקים את השורה הזאת בתוך ה-head של דף הבית של האתר:</p>
  <pre dir="ltr" class="code">${esc(tag)}</pre>
</section>
<form class="panel" method="post" action="/start/verify">${csrfField(r.ctx)}
  <button class="btn primary" type="submit">${icon('refresh')}לבדוק עכשיו</button>
  <p class="small muted mt12 m0">אחרי שהאתר מאומת, תורן קורא ממנו את המוצרים ואת דפי המדיניות. אם משהו לא מסתדר,${writeUs}</p>
</form>
<form class="panel" method="post" action="/start">${csrfField(r.ctx)}
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
      if (found.claim) return { html: verifyPage(app, r, found.claim) };
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
      if (r.scope.operator) throw new ActionError('לא נמצא', 404);
      if (!may(r)) throw new ActionError('במצב צפייה אי אפשר לשנות כלום.', 403);
      const ws = Number(r.scope.workspaceId);
      const claim = await pendingClaim(app, ws);
      if (!claim) return { redirect: '/' };
      const recent = await app.db.one(`SELECT 1 FROM audit WHERE action = 'verify_domain' AND detail->>'workspace' = $1 AND at > now() - interval '${VERIFY_SECONDS} seconds' LIMIT 1`, [String(ws)]);
      if (recent) throw new ActionError('בדקנו לפני רגע. אפשר לבדוק שוב בעוד כמה שניות.', 429);
      const res = await checkClaim(app, claim);
      await audit(app.db, { actor: r.user.name, action: 'verify_domain', detail: { workspace: ws, domain: claim.domain, ok: res.ok, how: res.how, why: res.why } });
      if (!res.ok) throw new ActionError('עוד לא מצאנו את הקוד באתר או ב-DNS. אם הוספתם אותו עכשיו, כדאי לחכות כמה דקות ולבדוק שוב.', 422);
      return addStore(app, r, ws, { url: claim.url, domain: claim.domain });
    }],
  ];
}
