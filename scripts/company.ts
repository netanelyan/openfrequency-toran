// npm run company -- sync <export.json> [--slug support]
//   create or update a company store (OpenFrequency's own support) from the site's export: openfrequency-web,
//   `npm run support -- <export.json>`. docs/company.md has the whole setup.
// npm run company -- show
//   the company stores here: their plans, questions, pages and connected channels
// npm run company -- email <domain> on|off
//   connect or disconnect the store's email address (<slug>@TORAN_MAIL_DOMAIN), as "לחבר מייל" on its lead page does

import { readFileSync } from 'node:fs';
import { makeApp } from '../src/app.ts';
import { COMPANY, syncCompany } from '../src/company.ts';
import { enabledChannels, storeAddress } from '../src/channels/config.ts';
import { audit } from '../src/db/log.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const app = await makeApp({ quiet: true });
const say = (m: string) => console.log(m);

try {
  const cmd = args[0];
  if (cmd === 'sync' && args[1]) {
    const s = await syncCompany(app, JSON.parse(readFileSync(args[1], 'utf8')), { slug: flag('slug') || 'support' });
    say(`${s.created ? 'Created' : 'Updated'} company store ${s.storeId}${s.slug ? ` (slug ${s.slug})` : ''}: ${s.plans} plans, ${s.faqs} questions${s.faqsRemoved ? ` (${s.faqsRemoved} the site dropped, removed)` : ''}, ${s.policies} pages in ${s.chunks} chunks${s.embedded ? '' : ' (embeddings off: get_policy matches words only)'}.`);
    say(`Its email address, once connected on /lead/${s.storeId}: ${s.slug || `store-${s.storeId}`}@${app.env.TORAN_MAIL_DOMAIN || '<TORAN_MAIL_DOMAIN>'}`);
  } else if (cmd === 'show') {
    const stores = await app.db.query<any>('SELECT id, domain, slug, config, ingested_at FROM stores WHERE platform = $1 ORDER BY id', [COMPANY]);
    if (!stores.length) say('No company store here. Create one with: npm run company -- sync <export.json>');
    for (const s of stores) {
      const n = async (sql: string) => (await app.db.one<{ n: number }>(sql, [s.id]))!.n;
      const channels = await app.db.query<{ channel: string; external_id: string; status: string }>('SELECT channel, external_id, status FROM channel_accounts WHERE store_id = $1 ORDER BY id', [s.id]);
      say(`${s.id} ${s.domain} (slug ${s.slug || 'none'}), synced ${new Date(s.ingested_at).toISOString()} from an export of ${s.config?.company?.generatedAt || '?'}`);
      say(`  ${await n('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND gone_at IS NULL')} plans, ${await n('SELECT COUNT(*)::int AS n FROM faqs WHERE store_id = $1')} questions (${await n('SELECT COUNT(*)::int AS n FROM faqs WHERE store_id = $1 AND answer IS NOT NULL')} with the owner's answer), ${await n('SELECT COUNT(*)::int AS n FROM policies WHERE store_id = $1')} pages`);
      say(`  channels: ${channels.map((c) => `${c.channel} ${c.external_id} (${c.status})`).join(', ') || 'none connected'}`);
    }
  } else if (cmd === 'email' && args[1] && (args[2] === 'on' || args[2] === 'off')) {
    const s = await app.db.one<any>('SELECT id, slug, name FROM stores WHERE domain = $1 AND platform = $2', [args[1], COMPANY]);
    if (!s) throw new Error(`no company store ${args[1]}`);
    if (!enabledChannels(app.env).has('email') || !app.mail) throw new Error('email is off on this server (TORAN_CHANNELS, the Resend settings)');
    const address = storeAddress(s, app.mail.domain);
    if (args[2] === 'on') {
      const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'email' AND external_id = $1", [address]);
      if (taken && taken.store_id !== s.id) throw new Error(`${address} belongs to store ${taken.store_id}`);
      await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', $2, $3, $4) ON CONFLICT (channel, external_id) DO UPDATE SET status = 'active', kind = EXCLUDED.kind, name = EXCLUDED.name, connected_at = now()", [s.id, app.mail.kind, address, s.name]);
    } else await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1 AND channel = 'email'", [s.id]);
    await audit(app.db, { actor: 'cli', action: args[2] === 'on' ? 'email_connect' : 'email_disconnect', storeId: s.id, detail: { address } });
    say(args[2] === 'on' ? `Connected: mail to ${address} is answered by store ${s.id}.` : `Disconnected ${address}.`);
  } else {
    say('npm run company -- sync <export.json> [--slug support] | show | email <domain> on|off');
    process.exitCode = 1;
  }
} finally {
  await app.db.close();
}
