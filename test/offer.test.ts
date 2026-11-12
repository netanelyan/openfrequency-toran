import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { ACCOUNTS_PLANS, forgetFounders, foundersOffer, getOffer, PLANS_OFFER, setOffer } from '../src/offer.ts';
import { PLANS } from '../src/plans.ts';
import { foundersLine, plansMain } from '../src/pitch/page.ts';
import { testApp } from './helpers.ts';

// What the pitch pages quote (src/offer.ts): the plans openfrequency-accounts sells and bills, not a settings row typed
// before them (the parent's check of 2026-11-12: every demo page said "449 ₪" with no big plan).

/** accounts' subscriptions.js beside this checkout (walking up from this repo's root, as test/contracts.test.ts does), or null. */
function accountsPlansFile(): string | null {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    const f = path.join(dir, 'openfrequency-accounts', 'src', 'accounts', 'subscriptions.js');
    if (existsSync(f)) return f;
  }
  return null;
}

test("the plans the pages quote are accounts' own, line for line, and the conversations are Toran's plans'", (t) => {
  const file = accountsPlansFile();
  if (!file) return t.skip("accounts' checkout is not beside this one");
  const src = readFileSync(file, 'utf8');
  const m = /toran:\s*\{\s*store:\s*\{\s*monthly:\s*(\d+),\s*setup:\s*(\d+),\s*conversations:\s*(\d+)\s*\},\s*big:\s*\{\s*monthly:\s*(\d+),\s*setup:\s*(\d+),\s*conversations:\s*(\d+)\s*\}/.exec(src);
  assert.ok(m, "accounts' PLANS.toran in the shape this test reads (src/accounts/subscriptions.js)");
  const [, sm, ss, sc, bm, bs, bc] = m!.map(Number);
  assert.deepEqual(ACCOUNTS_PLANS, { store: { monthly: sm, setup: ss, conversations: sc }, big: { monthly: bm, setup: bs, conversations: bc } }, 'src/offer.ts ACCOUNTS_PLANS is accounts\' PLANS.toran');
  assert.match(src, /LIST_PRICES = \{ toran: \{ monthly: (\d+), setup: (\d+), vat: 'excluded' \}/, 'before VAT, as the pages say');
  assert.equal(PLANS.store.conversations, ACCOUNTS_PLANS.store.conversations);
  assert.equal(PLANS.big.conversations, ACCOUNTS_PLANS.big.conversations);
});

test('the pages quote the plans; a row saved before them is not a price; a price of our own stands only when set on purpose', async () => {
  const app = await testApp();
  try {
    assert.deepEqual(await getOffer(app.db), PLANS_OFFER, 'nothing saved: the plans');
    assert.equal(PLANS_OFFER.monthly, 590);
    assert.equal(PLANS_OFFER.bigMonthly, 1190);
    // The row as it stood on the server: typed before the plans, with no override.
    await app.db.query(`INSERT INTO settings (key, value) VALUES ('offer', '{"monthly":449,"vat":"excluded","setup":990,"city":"תל אביב","bigMonthly":null}'::jsonb)`);
    const shown = await getOffer(app.db);
    assert.equal(shown.monthly, 590, 'the plans win over an old row');
    assert.equal(shown.bigMonthly, 1190);
    assert.equal(shown.city, 'תל אביב', 'the city stays the operator\'s');
    // The settings form says whether the price is ours; a price saved without saying so is ours.
    await setOffer(app.db, { monthly: 499, vat: 'excluded', setup: 0, city: 'אשדוד', override: false });
    assert.equal((await getOffer(app.db)).monthly, 590, 'unticked: still the plans');
    await setOffer(app.db, { monthly: 499, vat: 'excluded', setup: 0, city: 'אשדוד', override: true });
    assert.deepEqual([(await getOffer(app.db)).monthly, (await getOffer(app.db)).setup], [499, 0]);
  } finally {
    await app.db.close();
  }
});

test("the founders' offer is read from accounts' public counter, kept ten minutes, and anything else is no offer", async () => {
  const env = { OF_ACCOUNTS_URL: 'https://accounts.openfrequency.co.il' };
  const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  forgetFounders();
  let asked = 0;
  assert.equal(await foundersOffer({ OF_ACCOUNTS_URL: 'https://accounts.test' }, (async () => (asked++, new Response('{}'))) as unknown as typeof fetch), null);
  assert.equal(asked, 0, 'a name that cannot resolve is not asked');
  forgetFounders();
  assert.deepEqual(await foundersOffer(env, answer({ spots: 10, left: 8 })), { spots: 10, left: 8 });
  assert.deepEqual(await foundersOffer(env, answer({ spots: 10, left: 0 })), { spots: 10, left: 8 }, 'kept');
  for (const bad of [{ spots: 10 }, { spots: 0, left: 0 }, { spots: 10, left: 11 }, 'nope']) {
    forgetFounders();
    assert.equal(await foundersOffer(env, answer(bad)), null, JSON.stringify(bad));
  }
  forgetFounders();
  assert.equal(await foundersOffer(env, answer({ error: 'down' }, 503)), null);
  forgetFounders();
  assert.equal(await foundersOffer(env, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch), null);
  forgetFounders();
  assert.equal(await foundersOffer({ OF_ACCOUNTS_URL: 'http://accounts.openfrequency.co.il' }, answer({ spots: 10, left: 8 })), null, 'https only');
  forgetFounders();
});

test("the pitch page says the founders' offer under the setup fee only while spots are left", () => {
  const o = { ...PLANS_OFFER };
  assert.equal(foundersLine(o, { spots: 10, left: 8 }), ' ל־8 העסקים הבאים שמצטרפים אין דמי הקמה.');
  assert.equal(foundersLine(o, { spots: 10, left: 1 }), ' לעסק הבא שמצטרף אין דמי הקמה.');
  assert.equal(foundersLine(o, { spots: 10, left: 0 }), '', 'full: nothing');
  assert.equal(foundersLine(o, null), '', 'accounts did not answer: nothing');
  assert.equal(foundersLine({ ...o, setup: 0 }, { spots: 10, left: 8 }), '', 'no setup fee to waive');
  assert.match(plansMain(o, { OF_ACCOUNTS_URL: 'https://accounts.openfrequency.co.il' }, '', { spots: 10, left: 8 }), /ועוד 990 ₪ דמי הקמה, פעם אחת\. ל־8 העסקים הבאים שמצטרפים אין דמי הקמה\./);
  assert.match(plansMain(o, { OF_ACCOUNTS_URL: 'https://accounts.openfrequency.co.il' }, ''), /<span class="num">1,190<\/span>/, 'both plans, from the plans');
});
