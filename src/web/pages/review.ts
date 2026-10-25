import type { App } from '../../app.ts';
import { J } from '../../db/index.ts';
import { audit } from '../../db/log.ts';
import { forgetStorePrompt } from '../../agent/loop.ts';
import { money } from '../../agent/tools.ts';
import { buildPitch } from '../../pitch/build.ts';
import { brandColor, normHex } from '../../ingest/brand.ts';
import { pitchUrl } from '../../outreach.ts';
import { pitchGaps, type Gap } from '../../pitch/ready.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { storesOf } from '../workspace.ts';
import { ago, csrfField, esc, icon, layout, PLATFORM_HE, postButton, scoreNum, storeBadge } from '../ui.ts';

// The review queue: Teder's approval flow, for pitch pages. Each store whose page is
// built and not yet approved is a card: who it is, the sample chat the page shows, what
// the checks found, what still holds the page back (pitch/ready.ts: approve stays off
// until that list is empty), and Approve / Edit / Skip. Approve posts in the background and the
// card leaves (Teder's ajax "remove"); Skip asks for a reason first.
//
// The edit screen is the knowledge pack: fix a wrong price or a wrong line, answer an
// FAQ, set the brand colour; every correction is an override that survives the daily
// re-scrape. The products come 40 a page (corrected ones first), with a search that
// keeps its words from page to page. The page is previewed in a phone-sized frame
// beside it on a wide screen; on a phone the frame is at the top, behind a tap, so the
// page is a tap away and not under every product.

const PER_PAGE = 40;

async function flagsFor(app: App, s: any): Promise<{ good: string[]; warn: string[] }> {
  const good: string[] = [];
  const warn: string[] = [];
  const pol = await app.db.query<{ kind: string }>('SELECT kind FROM policies WHERE store_id = $1', [s.id]);
  const n = await app.db.one<any>('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE available)::int AS a FROM products WHERE store_id = $1 AND gone_at IS NULL', [s.id]);
  const ingest = await app.db.one<any>("SELECT data FROM events WHERE store_id = $1 AND kind = 'ingest' ORDER BY at DESC LIMIT 1", [s.id]);
  good.push(`${n?.n || 0} מוצרים, ${n?.a || 0} במלאי`);
  if (pol.some((p) => p.kind === 'shipping')) good.push('מדיניות משלוחים');
  else warn.push('לא נמצא דף משלוחים, אז שאלות על משלוח יעברו אליך');
  if (pol.some((p) => p.kind === 'returns')) good.push('מדיניות החזרות');
  else warn.push('לא נמצא דף החזרות');
  if (!s.brand?.tone) warn.push('לא נמצאה דוגמה לטון הכתיבה של החנות');
  if (!s.contact_whatsapp && !s.contact_email) warn.push('לא מצאתי באתר וואטסאפ או מייל, אז אין לאן לשלוח');
  for (const w of ingest?.data?.warnings || []) if (/currency/.test(w)) warn.push(`מטבע: ${w}`);
  return { good, warn };
}

/** What holds a page back, in red, above everything else on its card. */
const gapList = (gaps: Gap[]) => (gaps.length ? `<ul class="gaps">${gaps.map((g) => `<li>${icon('alert')}${esc(g.he)}</li>`).join('')}</ul>` : '');

function chatBubbles(chat: { role: string; text: string }[]) {
  return `<div class="chat">${chat.map((m) => `<div class="b ${m.role === 'agent' ? 'agent' : 'customer'}">${esc(m.text)}</div>`).join('')}</div>`;
}

async function reviewQueue(app: App, r: DashReq) {
  const rows = await app.db.query<any>(`SELECT s.*, p.sample_chat FROM stores s LEFT JOIN pitches p ON p.store_id = s.id WHERE s.status = 'page_ready' AND s.approved_at IS NULL AND ${storesOf(r.scope, 's')} ORDER BY s.score DESC, s.page_built_at`);
  const cards = [];
  const ready: number[] = [];
  for (const s of rows) {
    const f = await flagsFor(app, s);
    const gaps = await pitchGaps(app, s);
    if (!gaps.length) ready.push(s.id);
    const name = s.brand?.name || s.name || s.domain;
    cards.push(`<article class="card rcard" data-item>
  <div class="meta"><span class="chip">${esc(PLATFORM_HE[s.platform] || s.platform)}</span><span class="chip">נבנה ${esc(ago(s.page_built_at))}</span><span class="end">${scoreNum(s.score, s.qualified)}</span></div>
  <div class="who">${storeBadge(s)}<div><h3>${esc(name)}</h3><small><bdi class="ltr">${esc(s.domain)}</bdi></small></div></div>
  ${gapList(gaps)}
  <div class="preview">${chatBubbles(s.sample_chat || [])}</div>
  <div class="trust">${f.good.map((g) => `<span class="good">${icon('check')}${esc(g)}</span>`).join('')}${f.warn.map((w) => `<span class="warnc">${icon('alert')}${esc(w)}</span>`).join('')}</div>
  <div class="actions">
    ${gaps.length ? `<button class="btn primary" type="button" disabled>${icon('check')}לאשר</button>` : postButton(r.ctx, `/lead/${s.id}/approve`, 'לאשר', { cls: 'btn primary', ajax: 'remove', iconName: 'check' })}
    <a class="btn" href="/lead/${s.id}/review">${icon('edit')}לעריכה</a>
    <button class="btn ghost" type="button" data-toggle="#skip-${s.id}" aria-expanded="false">לדלג</button>
  </div>
  <form class="rejectbox" id="skip-${s.id}" method="post" action="/lead/${s.id}/skip" data-ajax="remove">${csrfField(r.ctx)}
    <select name="reason"><option value="רשת גדולה מדי">רשת גדולה מדי</option><option value="לא מתאים למוצר">לא מתאים למוצר</option><option value="כבר יש להם צ׳אט">כבר יש להם צ׳אט</option><option value="הנתונים באתר לא טובים">הנתונים באתר לא טובים</option><option value="אחר">אחר</option></select>
    <button class="btn danger" type="submit">לדלג על החנות</button>
  </form>
</article>`);
  }
  const held = rows.length - ready.length;
  const body = `<div class="head"><h1>לבדיקה</h1><p class="sub">${rows.length === 1 ? 'דף אחד מחכה לך. דף שמאשרים עובר לשליחה.' : rows.length ? `${rows.length} דפים מחכים לך. כל דף שמאשרים עובר לשליחה.` : 'אין דפים שמחכים.'}${held ? ` ${held === 1 ? 'לדף אחד חסר משהו, והוא לא נפתח לאף אחד עד שזה מתמלא.' : `ל־${held} דפים חסר משהו, והם לא נפתחים לאף אחד עד שזה מתמלא.`}` : ''}</p>${ready.length > 1 ? `<div class="end">${postButton(r.ctx, '/review/approve-all', `לאשר את ${ready.length} המוכנים`, { cls: 'btn primary sm', confirm: `לאשר ${ready.length} דפים?`, fields: { ids: ready.join(',') } })}</div>` : ''}</div>
${rows.length ? `<div class="cards">${cards.join('')}</div>` : `<div class="empty">${icon('review')}<b>הכול נבדק</b>חנות חדשה נכנסת לכאן כשהדף שלה מוכן. <a href="/leads">ללידים</a></div>`}`;
  return layout({ ...r.ctx, title: 'לבדיקה', active: 'review' }, body);
}

async function editPage(app: App, r: DashReq, id: number) {
  const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  if (!s.page_built_at) throw new ActionError('לחנות הזאת עוד אין דף. קודם צריך לבנות אותו.', 400);
  const q = (r.url.searchParams.get('q') || '').trim();
  const pitch = await app.db.one<any>('SELECT sample_chat, built_at FROM pitches WHERE store_id = $1', [id]);
  const where = `store_id = $1 AND gone_at IS NULL ${q ? 'AND lower(title) LIKE $2' : ''}`;
  const args = q ? [id, `%${q.toLowerCase()}%`] : [id];
  const found = (await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM products WHERE ${where}`, args))?.n || 0;
  const pages = Math.max(1, Math.ceil(found / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(r.url.searchParams.get('page') || '1', 10) || 1));
  const products = await app.db.query<any>(
    `SELECT id, title, price_min::float, price_max::float, available, override, url FROM products WHERE ${where} ORDER BY (override <> '{}'::jsonb) DESC, title, id LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
    args,
  );
  const total = await app.db.one<any>('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND gone_at IS NULL', [id]);
  const policies = await app.db.query<any>('SELECT id, kind, title, url, text, override_text FROM policies WHERE store_id = $1 ORDER BY kind', [id]);
  const faqs = await app.db.query<any>('SELECT id, question, site_answer, answer FROM faqs WHERE store_id = $1 ORDER BY id', [id]);
  const f = await flagsFor(app, s);
  const gaps = await pitchGaps(app, s);
  const brand = { ...(s.brand || {}), ...(s.brand_override || {}) };
  const name = brand.name || s.name || s.domain;
  const currency = s.config?.currency || 'ILS';
  const url = pitchUrl(app.env, s.slug);

  const productRows = products.map((p) => {
    const o = p.override || {};
    return `<tr><td data-k="מוצר"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></td>
<td class="n" data-k="מחיר באתר">${esc(p.price_min === p.price_max || p.price_max == null ? money(p.price_min, currency) : `${money(p.price_min, currency)}-${money(p.price_max, currency)}`)}</td>
<td data-k="תיקון"><form class="row" method="post" action="/lead/${id}/product/${p.id}" data-ajax="reload">${csrfField(r.ctx)}
<input type="number" step="0.01" min="0" name="price" value="${o.price ?? ''}" placeholder="מחיר מתוקן" aria-label="מחיר מתוקן">
<select name="available" aria-label="מלאי"><option value="">מלאי כמו באתר (${p.available ? 'יש' : 'אין'})</option><option value="1"${o.available === true ? ' selected' : ''}>יש במלאי</option><option value="0"${o.available === false ? ' selected' : ''}>אזל</option></select>
<label class="small"><input type="checkbox" name="hidden" value="1"${o.hidden ? ' checked' : ''}> להסתיר</label>
<button class="btn sm" type="submit">לשמור</button></form></td></tr>`;
  });

  // Page n of the products, with the search's words kept; the anchor brings the list back into view.
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (n > 1) p.set('page', String(n));
    return `/lead/${id}/review${p.size ? `?${p}` : ''}#products`;
  };
  const pager = pages > 1 ? `<nav class="pager mt12" aria-label="עמודי המוצרים">${page > 1 ? `<a class="btn sm" href="${esc(pageHref(page - 1))}" rel="prev">לעמוד הקודם</a>` : '<span></span>'}<span class="small muted">עמוד ${page} מתוך ${pages}</span>${page < pages ? `<a class="btn sm" href="${esc(pageHref(page + 1))}" rel="next">לעמוד הבא</a>` : '<span></span>'}</nav>` : '';

  const body = `<a class="back" href="/lead/${id}">${icon('chev')}${esc(name)}</a>
<div class="head"><h1 class="title">בדיקה ועריכה</h1><p class="sub">מה שמתקנים כאן נשמר מעל מה שנקרא מהאתר, ונשאר גם אחרי הרענון היומי.</p></div>
${gaps.length ? `<div class="banner bad">${icon('alert')}<div><b>הדף לא נפתח לאף אחד עד שזה מתמלא</b>${gapList(gaps)}</div></div>` : ''}
<div class="cols edit">
  <div class="grid12">
    <section class="panel"><header><h2>שיחת הדוגמה</h2><span class="end">${postButton(r.ctx, `/lead/${id}/sample`, 'לבנות מחדש', { cls: 'btn sm', iconName: 'refresh' })}</span></header>${chatBubbles(pitch?.sample_chat || [])}
      <p class="small muted mt8 m0">את התשובות כתב תורן מהנתונים של החנות${pitch?.built_at ? `, ${esc(ago(pitch.built_at))}` : ''}.</p></section>
    <section class="panel" id="products"><header><h2>מוצרים</h2><span class="end small muted">${total?.n || 0} בסך הכול${q ? `, ${found} מתאימים לחיפוש` : ''}</span></header>
      <form class="inline-form" method="get" action="/lead/${id}/review"><input type="search" name="q" value="${esc(q)}" placeholder="חיפוש מוצר" aria-label="חיפוש מוצר"><button class="btn" type="submit" aria-label="לחפש">${icon('search')}</button></form>
      ${productRows.length ? `<div class="scrollx mt12"><table class="table stack"><thead><tr><th>מוצר</th><th>מחיר באתר</th><th>תיקון</th></tr></thead><tbody>${productRows.join('')}</tbody></table></div>` : `<p class="muted mt12 m0">${q ? 'אין מוצר שהשם שלו כולל את זה.' : 'לא נקראו מוצרים מהאתר.'}</p>`}
      ${pager}
    </section>
    <section class="panel"><header><h2>מדיניות</h2></header>
      ${policies.length ? policies.map((p) => `<details class="panel mt12"><summary><b>${esc(p.title)}</b> <span class="chip">${esc(p.kind)}</span>${p.override_text ? '<span class="chip sig">תוקן</span>' : ''}</summary>
      <form method="post" action="/lead/${id}/policy/${p.id}">${csrfField(r.ctx)}<label class="f">הטקסט שתורן קורא. אם משאירים ריק, הוא קורא את מה שבאתר<textarea name="override_text" rows="8" dir="rtl">${esc(p.override_text || '')}</textarea></label>
      <details class="mt8"><summary class="small">מה כתוב באתר</summary><blockquote class="q mt8">${esc(p.text.slice(0, 3000))}</blockquote></details>
      <button class="btn sm mt12" type="submit">לשמור</button></form></details>`).join('') : '<p class="muted m0">לא נמצאו דפי מדיניות באתר. כל שאלה על משלוח או החזרה תעבור אליך.</p>'}
    </section>
    <section class="panel"><header><h2>שאלות נפוצות</h2></header>
      ${faqs.length ? faqs.map((x) => `<form class="mt12" method="post" action="/lead/${id}/faq/${x.id}" data-ajax="reload">${csrfField(r.ctx)}<label class="f">${esc(x.question)}${x.site_answer ? `<small>באתר: ${esc(x.site_answer.slice(0, 200))}</small>` : ''}<textarea name="answer" rows="2" dir="rtl" placeholder="התשובה שלך. תורן יענה לפיה ולא לפי האתר">${esc(x.answer || '')}</textarea></label><button class="btn sm mt8" type="submit">לשמור</button></form>`).join('') : '<p class="muted m0">לא נמצאו שאלות באתר.</p>'}
      <form class="mt16" method="post" action="/lead/${id}/faq">${csrfField(r.ctx)}<label class="f">שאלה חדשה<input type="text" name="question" dir="rtl" required></label><label class="f mt8">התשובה<textarea name="answer" rows="2" dir="rtl" required></textarea></label><button class="btn sm mt8" type="submit">${icon('plus')}להוסיף</button></form>
    </section>
  </div>
  <div class="grid12">
    <section class="panel p0x pvbox"><button class="btn pvtoggle" type="button" data-toggle="#pv" aria-expanded="false" aria-controls="pv">${icon('eye')}לראות איך הדף נראה</button><div class="pvframe" id="pv"><iframe class="pv" src="/s/${esc(s.slug)}?preview=1" title="תצוגה מקדימה של הדף" loading="lazy"></iframe></div></section>
    <a class="btn pvopen" href="${esc(url)}?preview=1" target="_blank" rel="noopener">${icon('ext')}לפתוח את הדף</a>
    <section class="panel"><header><h2>מותג</h2>${storeBadge(s)}</header>
      <form method="post" action="/lead/${id}/brand" class="formgrid">${csrfField(r.ctx)}
        <label class="f">השם שמופיע בדף<input type="text" name="name" value="${esc(brand.name || '')}" dir="auto"></label>
        <label class="f">צבע ראשי<small>${s.brand?.colorsFrom === 'logo' ? 'באתר לא מצאתי צבע, אז לקחתי אותו מהלוגו' : 'מהאתר'}: ${esc((s.brand?.colors || []).join(', ') || 'לא נמצא')}. עכשיו: ${esc(brandColor(brand) || 'אין צבע, אז הדף מחכה')}</small><input type="text" name="color" value="${esc(s.brand_override?.colors?.[0] || '')}" placeholder="#b4532a" dir="ltr"></label>
        <label class="f">לוגו (כתובת https)<input type="url" name="logo" value="${esc(s.brand_override?.logo || '')}" placeholder="${esc(s.brand?.logo || '')}" dir="ltr"></label>
        <label class="f">טון הכתיבה של החנות<small>מהטקסטים באתר. תורן כותב בסגנון הזה.</small><textarea name="tone" rows="5" dir="rtl">${esc(brand.tone || '')}</textarea></label>
        <button class="btn sm" type="submit">לשמור</button>
      </form>
    </section>
    <section class="panel"><header><h2>מה הבדיקות מצאו</h2></header><ul class="keys">${f.good.map((g) => `<li>${icon('check')}${esc(g)}</li>`).join('')}${f.warn.map((w) => `<li>${icon('alert')}${esc(w)}</li>`).join('')}</ul></section>
  </div>
</div>
<div class="actionbar">
  ${s.approved_at ? postButton(r.ctx, `/lead/${id}/unapprove`, 'לבטל את האישור', { cls: 'btn' }) : gaps.length ? `<button class="btn primary" type="button" disabled>${icon('check')}לאשר את הדף</button>` : postButton(r.ctx, `/lead/${id}/approve`, 'לאשר את הדף', { cls: 'btn primary', iconName: 'check', fields: { next: `/lead/${id}` } })}
  <a class="btn" href="/lead/${id}">חזרה לליד</a>
</div>`;
  return layout({ ...r.ctx, title: `בדיקה: ${name}`, active: 'review' }, body);
}

export function reviewRoutes(app: App): Route<DashReq>[] {
  const touch = async (id: number) => {
    await app.db.query('UPDATE stores SET updated_at = now() WHERE id = $1', [id]);
    forgetStorePrompt(id);
  };
  return [
    ['GET', /^\/review$/, async (r) => ({ html: await reviewQueue(app, r) })],
    ['GET', /^\/lead\/(\d+)\/review$/, async (r, m) => {
      const html = await editPage(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין ליד כזה', 404);
      return { html };
    }],
    // Approve all: the explicit ids the page listed, so a page built after the queue was opened is never approved unseen (Teder's rule).
    ['POST', /^\/review\/approve-all$/, async (r) => {
      const ids = String(r.form.ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
      if (!ids.length) throw new ActionError('אין מה לאשר');
      // Only the session's workspace's pages with nothing missing: the server checks again, whatever the form said.
      const complete: number[] = [];
      for (const s of await app.db.query<any>(`SELECT id, name, brand, brand_override FROM stores WHERE id = ANY($1::int[]) AND ${storesOf(r.scope)}`, [ids])) if (!(await pitchGaps(app, s)).length) complete.push(s.id);
      const done = complete.length ? await app.db.query("UPDATE stores SET approved_at = now() WHERE id = ANY($1::int[]) AND status = 'page_ready' AND approved_at IS NULL RETURNING id", [complete]) : [];
      await audit(app.db, { actor: r.user.name, action: 'approve_all', detail: { ids: done.map((d: any) => d.id) } });
      return { message: `${done.length} דפים אושרו`, redirect: '/' };
    }],
    ['POST', /^\/lead\/(\d+)\/product\/(\d+)$/, async (r, m) => {
      const id = Number(m[1]);
      const p = await app.db.one<any>('SELECT id, override FROM products WHERE id = $1 AND store_id = $2', [Number(m[2]), id]);
      if (!p) throw new ActionError('אין מוצר כזה', 404);
      const o: Record<string, unknown> = {};
      const price = String(r.form.price || '').trim();
      if (price) {
        const v = Number(price);
        if (!Number.isFinite(v) || v < 0 || v > 1_000_000) throw new ActionError('המחיר לא תקין');
        o.price = Math.round(v * 100) / 100;
      }
      if (r.form.available === '1') o.available = true;
      if (r.form.available === '0') o.available = false;
      if (r.form.hidden === '1') o.hidden = true;
      await app.db.query('UPDATE products SET override = $2::jsonb WHERE id = $1', [p.id, J(o)]);
      await touch(id);
      await audit(app.db, { actor: r.user.name, action: 'product_override', storeId: id, detail: { productId: p.id, ...o } });
      return { message: Object.keys(o).length ? 'התיקון נשמר' : 'חזר להיות כמו באתר' };
    }],
    ['POST', /^\/lead\/(\d+)\/policy\/(\d+)$/, async (r, m) => {
      const id = Number(m[1]);
      const text = String(r.form.override_text || '').trim();
      await app.db.query('UPDATE policies SET override_text = $3 WHERE id = $1 AND store_id = $2', [Number(m[2]), id, text || null]);
      await touch(id);
      await audit(app.db, { actor: r.user.name, action: 'policy_override', storeId: id, detail: { policyId: Number(m[2]), cleared: !text } });
      return { message: text ? 'הטקסט נשמר. תורן יקרא אותו במקום מה שבאתר.' : 'חזר להיות כמו באתר' };
    }],
    ['POST', /^\/lead\/(\d+)\/faq\/(\d+)$/, async (r, m) => {
      const id = Number(m[1]);
      await app.db.query('UPDATE faqs SET answer = $3 WHERE id = $1 AND store_id = $2', [Number(m[2]), id, String(r.form.answer || '').trim() || null]);
      await touch(id);
      return { message: 'התשובה נשמרה' };
    }],
    ['POST', /^\/lead\/(\d+)\/faq$/, async (r, m) => {
      const id = Number(m[1]);
      const q = String(r.form.question || '').trim();
      const a = String(r.form.answer || '').trim();
      if (q.length < 4 || !a) throw new ActionError('צריך שאלה ותשובה');
      await app.db.query('INSERT INTO faqs (store_id, question, answer) VALUES ($1, $2, $3)', [id, q.slice(0, 300), a.slice(0, 2000)]);
      await touch(id);
      return { message: 'השאלה נוספה' };
    }],
    ['POST', /^\/lead\/(\d+)\/brand$/, async (r, m) => {
      const id = Number(m[1]);
      const o: Record<string, unknown> = {};
      if (r.form.name?.trim()) o.name = r.form.name.trim().slice(0, 80);
      if (r.form.color?.trim()) {
        const c = normHex(r.form.color);
        if (!c) throw new ActionError('הצבע צריך להיות בצורה #b4532a');
        o.colors = [c];
      }
      if (r.form.logo?.trim()) {
        if (!/^https:\/\/\S+$/.test(r.form.logo.trim())) throw new ActionError('הלוגו צריך להיות כתובת https');
        o.logo = r.form.logo.trim();
      }
      if (r.form.tone?.trim()) o.tone = r.form.tone.trim().slice(0, 1500);
      await app.db.query('UPDATE stores SET brand_override = $2::jsonb, updated_at = now() WHERE id = $1', [id, J(o)]);
      forgetStorePrompt(id);
      await audit(app.db, { actor: r.user.name, action: 'brand_override', storeId: id, detail: o });
      return { message: 'המותג נשמר' };
    }],
    ['POST', /^\/lead\/(\d+)\/sample$/, async (r, m) => {
      const id = Number(m[1]);
      await buildPitch(app, id);
      await audit(app.db, { actor: r.user.name, action: 'rebuild_sample', storeId: id });
      return { message: 'שיחת הדוגמה נבנתה מחדש' };
    }],
  ];
}
