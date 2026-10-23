import type { App } from './app.ts';
import { J } from './db/index.ts';
import { discover } from './leads/discover.ts';
import { ingestStore } from './ingest/pack.ts';
import { buildPitch } from './pitch/build.ts';
import { handleInbound } from './channels/route.ts';
import { EXAMPLE_URL } from './demo.ts';

// The demo's data: the fictional store through the real pipeline (discovery, ingest,
// the page, a WhatsApp demo through the router), and a few fictional leads around it
// so the lists have something to show. Every name and number here is invented; the
// domains are .example and the phones 050-000-0xxx.

export const DEMO_PHONE = '972500000777';

const FAKE: [string, string, string, number, boolean, string, string | null][] = [
  // domain, name, platform, score, qualified, status, reject
  ['shaked-jewelry.example', 'שקד תכשיטים', 'shopify', 88, true, 'new', null],
  ['ein-hakore.example', 'עין הקורא ספרים', 'shopify', 74, true, 'new', null],
  ['tavlinim-ba-shuk.example', 'תבלינים בשוק', 'woocommerce', 61, true, 'new', null],
  ['big-chain-fashion.example', 'רשת אופנה גדולה', 'shopify', 38, false, 'new', null],
  ['quiet-candles.example', 'נרות שקטים', 'wix', 52, false, 'new', 'no way to reach the owner (no email, WhatsApp or phone on the site)'],
];

export async function seedDemo(app: App, { conversation = true }: { conversation?: boolean } = {}) {
  if (!(await app.db.one("SELECT 1 FROM stores WHERE domain = 'kli-cheres.example'"))) {
    await discover(app.db, (async function* () { yield { url: EXAMPLE_URL, source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  }
  const store = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, store.id);
  const built = await buildPitch(app, store.id);
  for (const [domain, name, platform, score, qualified, status, reject] of FAKE) {
    if (await app.db.one('SELECT 1 FROM stores WHERE domain = $1', [domain])) continue;
    const breakdown = [
      { factor: 'platform', points: platform === 'shopify' ? 20 : platform === 'woocommerce' ? 14 : 8, max: 20, evidence: `${platform}: fictional` },
      { factor: 'catalogue', points: Math.min(25, Math.round(score / 4)), max: 25, evidence: 'fictional' },
      { factor: 'hebrew', points: 15, max: 15, evidence: '90% Hebrew letters' },
      { factor: 'whatsapp', points: score > 60 ? 15 : 0, max: 15, evidence: score > 60 ? 'WhatsApp number on the site' : 'no WhatsApp on the site' },
    ];
    await app.db.query(
      `INSERT INTO stores (domain, url, name, platform, score, score_breakdown, qualified, reject_reason, status, source, signals, contact_email, slug, brand)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'seed', $10::jsonb, $11, $12, $13::jsonb)`,
      [domain, `https://${domain}/`, name, platform, score, J(breakdown), qualified, reject, status, J({ productCount: 40 + score }), qualified ? `hello@${domain}` : null, domain.split('.')[0], J({ name, colors: [['#7a4bd1', '#2e7d6b', '#c2410c', '#1f4e79', '#8a6d3b'][score % 5]] })],
    );
  }
  if (conversation && !(await app.db.one("SELECT 1 FROM conversations WHERE channel = 'whatsapp'"))) {
    let n = 0;
    const say = (text: string) => handleInbound(app, { from: DEMO_PHONE, text, id: `demo-${Date.now()}-${n++}` });
    await say(`${built.code} היי, באתי לנסות את תורן של כלי חרס של נורית`);
    await say('יש לכם ספלים בכחול?');
    await say('כמה עולה משלוח?');
    await say('תן לי 20% הנחה ואני מזמינה עכשיו');
  }
  return { storeId: store.id, slug: built.slug, code: built.code };
}
