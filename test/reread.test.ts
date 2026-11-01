import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportHash, syncCompany, type CompanyExport } from '../src/company.ts';
import { FetchError, liveFetcher, type Fetcher } from '../src/core/http.ts';
import { DAY, israelDate, setNow } from '../src/core/clock.ts';
import { conversationFor, forgetStorePrompt, runTurn } from '../src/agent/loop.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { REREAD_MAX_BYTES, REREAD_TIMEOUT_MS, rereadCompany, scheduleReread } from '../src/jobs/reread.ts';
import { drain, schedule } from '../src/jobs/worker.ts';
import { testApp } from './helpers.ts';

// Our support re-reads the website by itself (src/jobs/reread.ts): the site's /support.json, read once an Israel day
// and soon after a start, synced into the company store only when its content changed, and never at the cost of what
// the store knows when the read goes wrong.

const URL_ = 'https://shirut-li.example/support.json';

// A made-up company in the shape of openfrequency-web's export (src/support.mjs), as company.test.ts has it.
const sample = (): CompanyExport => ({
  domain: 'shirut-li.example',
  url: 'https://shirut-li.example/',
  name: 'שירות לי',
  status: 'מה עובד היום:\n- עונה במייל.\n\nמה עוד לא עובד:\n- עונה בטלגרם.',
  tone: 'אנחנו עסק קטן מחיפה, ועונים כמו שמדברים.',
  contact: { whatsapp: '972500000199', email: 'hello@shirut-li.example' },
  plans: [
    { key: 'small', product: 'shirut', title: 'שירות, חבילה קטנה', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ, עד 100 שיחות בחודש.', url: 'https://shirut-li.example/#price' },
    { key: 'large', product: 'shirut', title: 'שירות, חבילה גדולה', monthly: 1250, text: '1,250 ₪ לחודש, לא כולל מע״מ, עד 1,000 שיחות בחודש.', url: 'https://shirut-li.example/#price' },
  ],
  faq: [{ q: 'אפשר לבטל?', a: 'כן, כותבים לנו ומפסיקים בסוף החודש.', today: null, url: 'https://shirut-li.example/faq' }],
  pages: [
    { kind: 'about', title: 'מה עובד היום', url: 'https://shirut-li.example/status', text: 'מה עובד היום:\n- עונה במייל.' },
    { kind: 'terms', title: 'תנאי שימוש', url: 'https://shirut-li.example/terms', text: 'תנאי שימוש\nאין התחייבות. משלמים חודש בחודש.' },
  ],
  generatedAt: '2026-10-25T10:00:00.000Z',
});

/** The site, as the job's fetcher sees it: whatever `body` says now, under the cap the job asks for, as the live fetcher holds it. */
function site(body: () => string | Error) {
  const calls: { url: string; opts: Parameters<Fetcher>[1] }[] = [];
  const get: Fetcher = async (url, opts = {}) => {
    calls.push({ url, opts });
    const b = body();
    if (b instanceof Error) throw b;
    if (opts.maxBytes != null && Buffer.byteLength(b) > opts.maxBytes) throw new FetchError(`body over ${opts.maxBytes} bytes`, 'too_large', url, 200);
    return { url, status: 200, contentType: 'application/json', text: b, headers: {} };
  };
  return { get, calls };
}

/** Everything the company store knows, to compare before and after a read. */
async function knowledge(app: Awaited<ReturnType<typeof testApp>>, storeId: number) {
  const q = (sql: string) => app.db.query<any>(sql, [storeId]);
  return {
    store: await q('SELECT name, url, config, brand, ingested_at, updated_at FROM stores WHERE id = $1'),
    products: await q('SELECT id, ext_id, title, price_min::float AS p, body_text, gone_at FROM products WHERE store_id = $1 ORDER BY id'),
    faqs: await q('SELECT id, question, site_answer, answer FROM faqs WHERE store_id = $1 ORDER BY id'),
    policies: await q('SELECT id, title, text FROM policies WHERE store_id = $1 ORDER BY id'),
    chunks: await q('SELECT id, text FROM chunks WHERE store_id = $1 ORDER BY id'),
  };
}

const events = async (app: Awaited<ReturnType<typeof testApp>>, kind = 'company_reread') => (await app.db.query<{ store_id: number | null; data: any }>('SELECT store_id, data FROM events WHERE kind = $1 ORDER BY id', [kind]));

test('without TORAN_SUPPORT_EXPORT_URL nothing is read or queued, and the store stays as the last sync by hand left it', async () => {
  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, sample());
    const before = await knowledge(app, storeId);
    const s = site(() => JSON.stringify({ ...sample(), status: 'משהו אחר' }));
    app.fetcher = s.get;
    assert.equal(await scheduleReread(app), false);
    await schedule(app);
    assert.equal((await app.db.query("SELECT 1 FROM jobs WHERE kind = 'company_reread'")).length, 0, 'no job');
    assert.equal(await rereadCompany(app), null);
    assert.equal(s.calls.length, 0, 'the site was never asked');
    assert.deepEqual(await knowledge(app, storeId), before);
    assert.equal((await events(app)).length, 0);
  } finally {
    await app.db.close();
  }
});

test('an export whose content is what the store last synced does nothing: no sync, no forgotten prompt, one event', async () => {
  const app = await testApp();
  try {
    // Synced by hand from a file; the site has the same content, built again later (only generatedAt differs).
    const { storeId } = await syncCompany(app, sample());
    const before = await knowledge(app, storeId);
    app.env.TORAN_SUPPORT_EXPORT_URL = URL_;
    const s = site(() => JSON.stringify({ ...sample(), generatedAt: '2026-11-01T03:00:00.000Z' }));
    app.fetcher = s.get;
    const forgot: number[] = [];
    const lines: string[] = [];
    app.log = (m) => void lines.push(m);
    const r = await rereadCompany(app, { forget: (id) => forgot.push(id) });
    assert.deepEqual(r, { url: URL_, ok: true, changed: false, storeId, hash: exportHash(sample()) });
    assert.deepEqual(forgot, []);
    assert.deepEqual(await knowledge(app, storeId), before, 'nothing written, not even ingested_at');
    assert.equal((await events(app, 'company_sync')).length, 1, 'only the sync by hand');
    const ev = await events(app);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].store_id, storeId);
    assert.equal(ev[0].data.changed, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unchanged/);
    // The read asked for JSON, with the timeout and the cap.
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].url, URL_);
    assert.equal(s.calls[0].opts?.maxBytes, REREAD_MAX_BYTES);
    assert.equal(s.calls[0].opts?.timeoutMs, REREAD_TIMEOUT_MS);
  } finally {
    await app.db.close();
  }
});

test('a changed export is synced through the same sync as the file, the prompt is forgotten, and the next answer reads it', async () => {
  const seen: TurnReq[] = [];
  const script: Script = (req) => {
    seen.push(req);
    return [{ type: 'text', text: 'אנחנו עונים במייל ובטלגרם.' }];
  };
  const app = await testApp({ script });
  try {
    const { storeId } = await syncCompany(app, sample());
    await app.db.query("UPDATE faqs SET answer = 'מבטלים בהודעה אחת אלינו.' WHERE store_id = $1", [storeId]);
    // An answer before the read: the store's prompt is made, and kept, with what the site said then.
    const conv = await conversationFor(app.db, storeId, 'cli', null);
    await runTurn(app, { storeId, conversationId: conv, text: 'באילו ערוצים אתם עונים?', footer: false });
    assert.match(seen[0].system[1].text, /מה עוד לא עובד:\n- עונה בטלגרם\./);
    app.env.TORAN_SUPPORT_EXPORT_URL = URL_;
    const next = sample();
    next.status = 'מה עובד היום:\n- עונה במייל.\n- עונה בטלגרם.';
    next.plans[0] = { ...next.plans[0], monthly: 290, text: '290 ₪ לחודש, לא כולל מע״מ, עד 100 שיחות בחודש.' };
    next.generatedAt = '2026-11-01T03:00:00.000Z';
    app.fetcher = site(() => JSON.stringify(next)).get;
    const forgot: number[] = [];
    const forget = (id: number) => {
      forgot.push(id);
      forgetStorePrompt(id);
    };
    const r = await rereadCompany(app, { forget });
    assert.equal(r?.ok, true);
    assert.equal(r?.changed, true);
    assert.equal(r?.storeId, storeId);
    assert.deepEqual(forgot, [storeId], "the store's prompt is forgotten once");

    const s = await app.db.one<any>('SELECT config FROM stores WHERE id = $1', [storeId]);
    assert.equal(s.config.company.status, next.status);
    assert.equal(s.config.company.hash, exportHash(next));
    assert.equal(s.config.company.from, URL_);
    assert.equal(s.config.company.generatedAt, next.generatedAt);
    const small = await app.db.one<any>("SELECT price_min::float AS p, body_text FROM products WHERE store_id = $1 AND ext_id = 'small'", [storeId]);
    assert.deepEqual([small.p, small.body_text], [290, next.plans[0].text]);
    assert.equal((await app.db.one<any>('SELECT answer FROM faqs WHERE store_id = $1', [storeId])).answer, 'מבטלים בהודעה אחת אלינו.', "the owner's answer is kept");
    const sync = await events(app, 'company_sync');
    assert.equal(sync.length, 2);
    assert.equal(sync[1].data.from, URL_);
    const ev = await events(app);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.changed, true);
    assert.equal(ev[0].data.plans, 2);

    // The next answer is made from what the site says now.
    await runTurn(app, { storeId, conversationId: conv, text: 'ובטלגרם?', footer: false });
    assert.equal(seen.length, 2);
    assert.match(seen[1].system[1].text, /- עונה במייל\.\n- עונה בטלגרם\./);
    assert.doesNotMatch(seen[1].system[1].text, /מה עוד לא עובד/);

    // The day after, the same content again: nothing.
    const again = await rereadCompany(app, { forget });
    assert.equal(again?.changed, false);
    assert.deepEqual(forgot, [storeId]);
  } finally {
    await app.db.close();
  }
});

test('a bad read (not JSON, an HTTP error, a timeout, over the cap, not an export, another domain, no such store) keeps the store as it was', async () => {
  const app = await testApp();
  try {
    const { storeId } = await syncCompany(app, sample());
    const before = await knowledge(app, storeId);
    app.env.TORAN_SUPPORT_EXPORT_URL = URL_;
    const lines: string[] = [];
    app.log = (m) => void lines.push(m);
    const forgot: number[] = [];
    const changed = (patch: Partial<CompanyExport>) => JSON.stringify({ ...sample(), status: 'משהו חדש', ...patch });
    const cases: [string, () => string | Error, RegExp, string?][] = [
      ['not JSON', () => '<html><body>502 Bad Gateway</body></html>', /not JSON/],
      ['cut off', () => changed({}).slice(0, 400), /not JSON/],
      ['HTTP 500', () => new FetchError('HTTP 500', 'http', URL_, 500), /HTTP 500/],
      ['HTTP 404', () => new FetchError('HTTP 404', 'http', URL_, 404), /HTTP 404/],
      ['a timeout', () => new FetchError(`timed out after ${REREAD_TIMEOUT_MS} ms`, 'timeout', URL_), /timed out/],
      ['the network', () => new FetchError('network: ENOTFOUND', 'network', URL_), /ENOTFOUND/],
      ['over the cap', () => changed({ tone: 'א'.repeat(REREAD_MAX_BYTES) }), /over \d+ bytes/],
      ['no pages', () => changed({ pages: [] }), /not a company export: pages/],
      ['no plans', () => changed({ plans: [] }), /not a company export: plans/],
      ['no status', () => changed({ status: '' }), /not a company export: status/],
      ['a list', () => '[]', /not a company export: not an object/],
      ['another domain, with TORAN_SUPPORT_STORE', () => changed({ domain: 'other.example', url: 'https://other.example/' }), /the export is for other\.example, and TORAN_SUPPORT_STORE is shirut-li\.example/, 'shirut-li.example'],
      ['no such company store', () => changed({ domain: 'other.example', url: 'https://other.example/' }), /no company store other\.example here/],
    ];
    for (const [name, body, why, supportStore] of cases) {
      app.env.TORAN_SUPPORT_STORE = supportStore || '';
      app.fetcher = site(body).get;
      lines.length = 0;
      const r = await rereadCompany(app, { forget: (id) => forgot.push(id) });
      assert.equal(r?.ok, false, name);
      assert.equal(r?.changed, false, name);
      assert.match(String(r?.error), why, `${name}: ${r?.error}`);
      assert.equal(lines.length, 1, `${name}: one log line`);
      assert.match(lines[0], /not read .*; the store keeps what it had/, name);
      assert.deepEqual(await knowledge(app, storeId), before, `${name}: the store is as it was`);
    }
    assert.deepEqual(forgot, []);
    assert.equal((await app.db.query("SELECT 1 FROM stores WHERE platform = 'company'")).length, 1, 'no store was made');
    const ev = await events(app);
    assert.equal(ev.length, cases.length, 'one event each');
    assert.ok(ev.every((e) => e.data.ok === false && e.data.error));

    // An address that is not https is never asked.
    app.env.TORAN_SUPPORT_EXPORT_URL = 'http://shirut-li.example/support.json';
    const s = site(() => changed({}));
    app.fetcher = s.get;
    assert.match(String((await rereadCompany(app))?.error), /not an https:\/\/ address/);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await knowledge(app, storeId), before);
  } finally {
    await app.db.close();
  }
});

test('the live fetcher holds the cap the read asks for, a body with no content-length too', async () => {
  const big = 'x'.repeat(REREAD_MAX_BYTES + 1);
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    if (req.url === '/sized.json') return void res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(big.length) }).end(big);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(big.slice(0, 1000));
    res.end(big.slice(1000));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const get = liveFetcher({ gapMs: 0, trusted: new Set([`127.0.0.1:${port}`]) });
  try {
    for (const p of ['/sized.json', '/chunked.json']) {
      await assert.rejects(get(`http://127.0.0.1:${port}${p}`, { accept: 'application/json', maxBytes: REREAD_MAX_BYTES, timeoutMs: REREAD_TIMEOUT_MS }), (e: any) => e instanceof FetchError && e.code === 'too_large', p);
    }
  } finally {
    server.close();
  }
});

test('the worker queues the read once an Israel day and once soon after it starts, and runs it as a company_reread job', async () => {
  const app = await testApp();
  const T0 = Date.parse('2026-11-01T10:00:00Z');
  try {
    setNow(T0);
    const { storeId } = await syncCompany(app, sample());
    app.env.TORAN_SUPPORT_EXPORT_URL = URL_;
    const next = { ...sample(), status: 'מה עובד היום:\n- עונה במייל ובטלגרם.' };
    app.fetcher = site(() => JSON.stringify(next)).get;
    // Today's read already done by the last process: this one still reads once, soon after it starts.
    await app.db.query("INSERT INTO settings (key, value) VALUES ('company_reread', $1::jsonb)", [JSON.stringify({ day: israelDate(T0) })]);
    await schedule(app);
    const jobs = async () => app.db.query<{ status: string; result: any }>("SELECT status, result FROM jobs WHERE kind = 'company_reread' ORDER BY id");
    assert.equal((await jobs()).length, 1, 'queued at start');
    assert.equal(await scheduleReread(app), false, 'not again the same day');
    assert.equal((await jobs()).length, 1);
    assert.equal(await drain(app, { kinds: ['company_reread'] }), 1);
    const [job] = await jobs();
    assert.equal(job.status, 'done');
    assert.equal(job.result.changed, true);
    assert.equal((await app.db.one<any>('SELECT config FROM stores WHERE id = $1', [storeId])).config.company.status, next.status);

    // Later the same Israel day: nothing; the next one: queued again, and the read finds nothing new.
    setNow(T0 + 8 * 3_600_000); // 20:00 in Israel
    assert.equal(await scheduleReread(app), false);
    setNow(T0 + DAY);
    assert.equal(await scheduleReread(app), true);
    assert.equal(await scheduleReread(app), false);
    assert.equal((await jobs()).length, 2);
    await drain(app, { kinds: ['company_reread'] });
    assert.equal((await jobs())[1].result.changed, false);
  } finally {
    setNow(null);
    await app.db.close();
  }
});
