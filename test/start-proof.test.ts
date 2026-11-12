import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drain } from '../src/jobs/worker.ts';
import { claimFor, CODE_ATTEMPTS, CODE_SENDS, proofDeps, sendCode } from '../src/domainProof.ts';
import { simEmail } from '../src/channels/email.ts';
import { FetchError } from '../src/core/http.ts';
import { readFailure, readFailureKind } from '../src/ingest/readFailure.ts';
import { customer, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// What /start says while a site is proven and read (src/web/pages/start.ts, src/domainProof.ts), as the pre-launch
// audit found it on 2026-11-12: words a store owner does not know (P1-14), why a reading failed (P1-25), and the proof
// page's details (P2-7). The fictional internet has tavlinim-ba-shuk.example (an address on the site, its own DNS),
// kli-cheres.example (a Shopify store) and wood-and-thread.example (a site that is not a store).

type S = Awaited<ReturnType<typeof serve>>;
const ajax = { 'x-tn-ajax': '1' };
async function asCustomer(s: S, ws: number) {
  s.as(s.accounts.session(customer(ws)).cookie);
  return (await s.csrf('/start')) || (await s.csrf('/'));
}
const page = async (s: S) => (await s.get('/start')).text();
/** The ready messages a page offers to send on WhatsApp (wa.me/?text=), as the person who gets one reads it. */
const messagesOf = (html: string) => [...html.matchAll(/href="https:\/\/wa\.me\/\?text=([^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
/** What a person reads on the page: no links' addresses, no tags. */
const visible = (html: string) => html.replace(/<(script|style)[^]*?<\/\1>/g, '').replace(/\s(href|action|src)="[^"]*"/g, '').replace(/<[^>]+>/g, ' ');
const lookAgain = (s: S) => s.app.db.query("UPDATE audit SET at = now() - interval '1 minute' WHERE action = 'verify_domain'");

test('a failed read in the owner\'s words: each reason the worker writes, and a generic line for the rest', () => {
  const cases: [string | null, string][] = [
    ['האתר לא נכנס כליד: not an online store (no platform, cart or products found)', 'not_store'],
    ['האתר לא נכנס כליד: the store has no products', 'not_store'],
    ['the product feed is empty', 'not_store'],
    ['האתר לא נכנס כליד: not an Israeli Hebrew store', 'not_hebrew'],
    ['האתר לא נכנס כליד: timed out after 15000 ms', 'no_answer'],
    ['האתר לא נכנס כליד: network: ENOTFOUND', 'no_answer'],
    ['האתר לא נכנס כליד: HTTP 503', 'no_answer'],
    ['האתר לא נמצא או לא ענה', 'no_answer'],
    ['האתר לא נכנס כליד: robots.txt disallows /', 'blocked'],
    ['האתר לא נכנס כליד: HTTP 403', 'blocked'],
    ['האתר לא נכנס כליד: redirects to other-shop.example', 'moved'],
    ["the store is already another workspace's", 'taken'],
    ['ingest for konimbo is not built yet: Toran reads Shopify, WooCommerce, Wix and Cashcow stores', 'platform'],
    ['האתר לא נכנס כליד: sells what WhatsApp Business does not allow (weapons: "rifles")', 'other'],
    [null, 'other'],
  ];
  for (const [error, kind] of cases) assert.equal(readFailureKind(error), kind, String(error));
  assert.match(readFailure(cases[0][0]).text, /^לא מצאנו באתר הזה מוצרים או עגלת קניות\. אם החנות בכתובת אחרת, כותבים אותה ומנסים שוב\./);
  assert.equal(readFailure(cases[0][0]).retry, true, 'another address is a try worth making');
  assert.equal(readFailure('the product feed is empty', { store: true }).retry, false, 'a store has its address: no other to type');
  assert.match(readFailure(cases[3][0]).text, /לא בעברית/);
  assert.equal(readFailure(cases[3][0]).retry, false);
  assert.match(readFailure(cases[10][0]).text, /לאתר אחר, other-shop\.example\./);
  for (const [error] of cases) {
    for (const store of [false, true]) {
      const t = readFailure(error, { store }).text;
      assert.doesNotMatch(t, /\b(not|store|HTTP|robots|network|timed|feed|lead|redirects|ENOTFOUND)\b/i, `${error}: no English reason shown`);
      assert.doesNotMatch(t, /[—–]/);
    }
  }
});

test('/start after a site that is not a store: the banner says why, and what to do next, under the same title', async () => {
  const s = await serve();
  const was = proofDeps.resolveTxt;
  try {
    const token = await asCustomer(s, 41);
    assert.equal((await s.post('/start', { _csrf: token, url: 'wood-and-thread.example' })).headers.get('location'), '/start');
    const claim = (await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 41'))!;
    proofDeps.resolveTxt = async (host: string) => (host === claim.domain ? [[`toran-verify=${claim.token}`]] : []);
    assert.equal((await s.post('/start/verify', { _csrf: token })).headers.get('location'), '/');
    await drain(s.app);
    const job = await s.app.db.one<any>("SELECT status, last_error FROM jobs WHERE kind = 'add_store' AND payload->>'workspaceId' = '41'");
    assert.equal(job.status, 'failed');
    const html = await page(s);
    assert.match(html, /<b>לא הצלחנו לקרוא את האתר הקודם<\/b><p>לא מצאנו באתר הזה מוצרים או עגלת קניות\./, `the reason in the owner's words (the job said: ${job.last_error})`);
    assert.doesNotMatch(html, /not an online store|נכנס כליד/);
    // The form says the proof comes first, and its button goes on.
    assert.match(html, /אחרי שמאמתים שהוא שלכם, תורן קורא ממנו את המוצרים/);
    assert.match(html, /<button class="btn primary mt12" type="submit">[^]*?להמשיך<\/button>/);
    assert.doesNotMatch(html, /לקרוא את האתר<\/button>/);
  } finally {
    proofDeps.resolveTxt = was;
    await s.close();
  }
});

test('the proof page in plain words: the TXT way is a ready message for whoever manages the domain, the tag card says where it goes without "head", an address is never cut at its hyphen', async () => {
  const s = await serve();
  try {
    s.app.mail = simEmail();
    const token = await asCustomer(s, 42);
    await s.post('/start', { _csrf: token, url: 'tavlinim-ba-shuk.example' });
    const claim = (await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 42'))!;
    const html = await page(s);
    const words = visible(html);
    assert.doesNotMatch(words, /DNS|TXT|רשומת/, 'no DNS, TXT or "record" for the owner to read');
    assert.match(html, /<h3 class="mt24">מי שמנהל לכם את הדומיין יכול לאשר מהצד שלו<\/h3>/);
    assert.match(html, /לשלוח למי שמנהל לכם את הדומיין/);
    const dns = messagesOf(html).find((m) => m.includes('רשומת TXT'));
    assert.ok(dns, 'the ready message');
    assert.ok(dns!.includes(`\ntoran-verify=${claim.token}\n`), 'the value on a line of its own');
    assert.ok(dns!.includes(`_toran-verify.${claim.domain}`), 'and the host');
    assert.match(html, /מעתיקים את השורה ומדביקים אותה באתר, במקום שמוסיפים בו קוד לכל הדפים\./);
    assert.doesNotMatch(html.split('<h3 class="small mt16">איפה מדביקים אותה</h3>')[0].split('verify-more')[1] || '', /head/, 'the tag card itself never says "head"');
    // The masked address is one box: a phone breaks the line before it, not at "tavlinim-ba-".
    assert.match(html, /<bdi class="ltr" dir="ltr">sh\*\*\*@tavlinim-ba-shuk\.example<\/bdi>/);
  } finally {
    await s.close();
  }
});

test('a Shopify store\'s key card has a ready message for whoever runs the store, with the steps, and the maqaf before Shopify', async () => {
  const s = await serve();
  try {
    const token = await asCustomer(s, 43);
    await s.post('/start', { _csrf: token, url: 'kli-cheres.example' });
    const html = await page(s);
    const main = html.split('verify-more')[0];
    assert.match(main, /<h2>מחברים את החנות ב־Shopify<\/h2>/);
    assert.match(main, /<summary class="small">מישהו אחר מנהל לכם את החנות\?<\/summary>/);
    const ask = messagesOf(main).find((m) => m.includes('Client ID'));
    assert.ok(ask, 'the steps in a message');
    assert.match(ask!, /^שלום, אפשר עזרה לחבר את החנות kli-cheres\.example לתורן\?/);
    assert.match(ask!, /מעתיקים אותם ושולחים לי\.\nתודה$/);
    assert.equal((main.match(/class="btn primary/g) || []).length, 1, 'still one main button');
  } finally {
    await s.close();
  }
});

test('what the last look found sits beside "לבדוק עכשיו", not above another card; a site that keeps us out is said plainly', async () => {
  const s = await serve();
  const was = proofDeps.resolveTxt;
  try {
    proofDeps.resolveTxt = async () => [];
    // An address on the site, so the code is the main card; the owner tried the tag once, and nothing is there yet.
    s.app.mail = simEmail();
    let token = await asCustomer(s, 44);
    await s.post('/start', { _csrf: token, url: 'tavlinim-ba-shuk.example' });
    const missing = await s.post('/start/verify', { _csrf: token }, ajax);
    assert.equal(missing.status, 422);
    assert.equal((await missing.json()).message, 'עוד לא מצאנו את השורה באתר. אם הוספתם אותה עכשיו, כדאי לחכות כמה דקות ולבדוק שוב.');
    let html = await page(s);
    const [before, after] = html.split('<section class="panel verify-main">');
    assert.doesNotMatch(before, /עוד לא מצאנו את השורה/, 'no banner above the main card');
    assert.match(after.split('verify-more')[0], /<h2>שולחים קוד למייל שמופיע באתר<\/h2>/);
    assert.doesNotMatch(after.split('verify-more')[0], /עוד לא מצאנו את השורה/, 'nor in the email card');
    assert.match(after.split('verify-more')[1], /עוד לא מצאנו את השורה באתר\.[^]*action="\/start\/verify"/, 'beside the tag\'s own button');
    assert.doesNotMatch(html, /רשומת DNS/);

    // A site whose home page refuses us (an error page, a block): the line may be there, and looking again the same
    // way will not show it.
    const fetcher = s.app.fetcher;
    s.app.fetcher = async (url, opts) => {
      if (new URL(url).hostname === 'closed-shop.example') throw new FetchError('HTTP 403', 'http', url, 403);
      return fetcher(url, opts);
    };
    token = await asCustomer(s, 45);
    assert.equal((await s.post('/start', { _csrf: token, url: 'closed-shop.example' })).headers.get('location'), '/start');
    await lookAgain(s);
    const blocked = await s.post('/start/verify', { _csrf: token }, ajax);
    assert.equal(blocked.status, 422);
    assert.match((await blocked.json()).message, /האתר לא נתן לנו להיכנס לדף הבית, אז אי אפשר לראות אם היא שם/);
    html = await page(s);
    assert.match(html.split('verify-more')[0], /האתר לא נתן לנו להיכנס לדף הבית/, 'said in the card the owner looks at');
  } finally {
    proofDeps.resolveTxt = was;
    await s.close();
  }
});

test('a code mail that failed is not one of the 3 codes an hour; tries that keep failing stop at their own limit', async () => {
  const app = await testApp();
  try {
    const mail = simEmail();
    app.mail = mail;
    const claim = await claimFor(app, 46, 'tavlinim-ba-shuk.example', 'https://tavlinim-ba-shuk.example/');
    const notice = mail.notice.bind(mail);
    let down = true;
    mail.notice = async (...a: Parameters<typeof notice>) => {
      if (down) throw new Error('the mail service refused');
      return notice(...a);
    };
    for (let i = 0; i < CODE_SENDS + 1; i++) await assert.rejects(sendCode(app, claim, 'shalom@tavlinim-ba-shuk.example', 'owner'), (e: any) => e.status === 502, `failed send ${i + 1}`);
    down = false;
    for (let i = 0; i < CODE_SENDS; i++) await sendCode(app, claim, 'shalom@tavlinim-ba-shuk.example', 'owner');
    assert.equal(mail.outbox!.filter((m) => /הקוד לאימות/.test(String(m.subject))).length, CODE_SENDS, 'every code that went counts');
    await assert.rejects(sendCode(app, claim, 'shalom@tavlinim-ba-shuk.example', 'owner'), (e: any) => e.status === 429, 'the fourth code that went is one too many');

    // Another claim, whose mail never goes: CODE_ATTEMPTS tries, then no more for the hour.
    const other = await claimFor(app, 47, 'beit-hasabon.example', 'https://beit-hasabon.example/');
    down = true;
    for (let i = 0; i < CODE_ATTEMPTS; i++) await assert.rejects(sendCode(app, other, 'hello@beit-hasabon.example', 'owner'), (e: any) => e.status === 502);
    await assert.rejects(sendCode(app, other, 'hello@beit-hasabon.example', 'owner'), (e: any) => e.status === 429 && /והמייל לא יצא/.test(e.he));
  } finally {
    await app.db.close();
  }
});
