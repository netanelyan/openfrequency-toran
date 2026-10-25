import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import type { Script } from '../src/agent/llm/scripted.ts';
import type { Inbound } from '../src/channels/types.ts';
import { testApp } from './helpers.ts';

// The fictional store with its email connected (and, when asked, its own WhatsApp number on the simulator), for the
// tests of the store's own domain, the files and one customer across channels.

export const DOMAIN = 'in.toran.test';
export const STORE_WA = '972500000100';
let seq = 0;

export async function mailStore({ script, whatsapp = false }: { script?: Script; whatsapp?: boolean } = {}) {
  const app = await testApp({ script });
  app.env.TORAN_CHANNELS = 'whatsapp,email';
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const s = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, s.id);
  await buildPitch(app, s.id);
  const store = (await app.db.one<{ id: number; slug: string }>('SELECT id, slug FROM stores WHERE id = $1', [s.id]))!;
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס של נורית')", [store.id, address]);
  // The store's own WhatsApp number, answered through the simulator (a Meta number is meta.test.ts's).
  if (whatsapp) await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'whatsapp', 'sim', $2, 'כלי חרס של נורית')", [store.id, STORE_WA]);
  return { app, storeId: store.id, address };
}

type Mail = Partial<{ from: string; subject: string; text: string; headers: Record<string, string>; attachments: unknown[]; message_id: string }>;

/** An email from a customer to `to`, as the simulator's webhook parses it. */
export const mail = (to: string, o: Mail = {}): Inbound =>
  simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from: 'Dana <dana@example.test>', to: [to], subject: 'שאלה על קערה', text: 'יש לכם קערה?', message_id: `<f${seq++}@example.test>`, ...o }), form: {}, headers: {}, url: '' })![0];

/** A WhatsApp message from `from` to the store's own number. */
export const wa = (from: string, text: string): Inbound => ({ channel: 'whatsapp', from, text, id: `wa-${seq++}`, account: STORE_WA, at: Date.now() });

/** A tiny real PNG (1x1), and the start of a real PDF: what sniff() recognises. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
