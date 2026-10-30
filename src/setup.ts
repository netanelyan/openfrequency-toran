import { pendingClaim, type Claim } from './domainProof.ts';
import type { App } from './app.ts';
import type { Out, Req, Route } from './web/server.ts';
import { local } from './ops/api.ts';
import { publicBase } from './auto/messages.ts';
import { INGESTIBLE_HE, canIngest } from './ingest/catalogue.ts';
import { enabledChannels } from './channels/config.ts';
import { waConnectReady } from './channels/meta.ts';
import { socialReady, type Social } from './channels/social.ts';
import { orderAccessOf, ordersPlatform } from './orders.ts';
import { anyOn, settingsOf } from './auto/send.ts';
import { waAccountOf } from './web/pages/whatsapp.ts';
import { socialAccountOf } from './web/pages/social.ts';

// A new customer's setup, step by step. openfrequency-accounts has one checklist page for a new workspace (/setup):
// it asks each product for the workspace's steps and shows them, and each step's button opens the product's own page
// where the customer does it. The session cookie is shared across *.openfrequency.co.il, so a link to Toran's
// pages arrives signed in. The same contract is Teder's: accounts renders both alike.
//
//   GET /internal/setup?workspace=<id>
//   { "product": "toran", "ready": <every required step done>,
//     "steps": [ { "key", "title", "status": todo | working | done | attention | soon, "detail", "href", "required" } ] }
//
// From this machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For (ops/api.ts local), like /internal/ops.
//
// The steps are about the workspace's store, its first one (a workspace has one for now), in this order:
//   store      required  the site read (pages/start.ts adds it): none yet, being read, read, or a site Toran cannot read
//   knowledge            "בודקים את התשובות": the owner opened what Toran knows (stores.knowledge_seen_at) or wrote an answer
//   whatsapp   required  the store's own number through Meta; "soon" while this server cannot connect one (waConnectReady)
//   email                only where TORAN_CHANNELS lists it; "soon" without a mail provider here
//   messenger, instagram only where TORAN_CHANNELS lists them; "soon" until socialReady
//   orders               the read-only order key; "soon" on a platform whose orders Toran does not read yet
//   auto                 the automatic messages: done once any kind is on
// Until the store exists, every step after it is todo, with no link, "אחרי שהחנות מוכנה". A workspace Toran has
// never heard of is a brand-new one, and answers the same way: nothing is an error here.
//
// Nothing here is new tracking: every state is read from what the pages already keep (jobs, channel_accounts,
// order_access, auto_settings), except the one marker above.

export type StepStatus = 'todo' | 'working' | 'done' | 'attention' | 'soon';
export type Step = { key: string; title: string; status: StepStatus; detail: string; href: string | null; required: boolean };
export type Setup = { product: 'toran'; ready: boolean; steps: Step[] };

const AFTER_STORE = 'אחרי שהחנות מוכנה';
const LIVE = ['queued', 'running'];

export type SetupStore = { id: number; domain: string; platform: string; ingested_at: string | null; knowledge_seen_at: string | null };
type JobRow = { id: number; kind: string; status: string; last_error: string | null; result: any };

/** The workspace's store (its first), the latest add from /start, and the latest reading of its site. */
export async function setupStoreOf(app: App, workspaceId: number): Promise<{ store: SetupStore | null; add: JobRow | null; read: JobRow | null; claim?: Claim | null }> {
  const store = await app.db.one<SetupStore>('SELECT id, domain, platform, ingested_at, knowledge_seen_at FROM stores WHERE workspace_id = $1 ORDER BY id LIMIT 1', [workspaceId]);
  const add = await app.db.one<JobRow>("SELECT id, kind, status, last_error, result FROM jobs WHERE kind = 'add_store' AND payload->>'workspaceId' = $1 ORDER BY id DESC LIMIT 1", [String(workspaceId)]);
  const read = store ? await app.db.one<JobRow>('SELECT id, kind, status, last_error, result FROM jobs WHERE dedupe_key = $1 ORDER BY id DESC LIMIT 1', [`ingest:${store.id}`]) : null;
  // A site typed at /start and not yet proven the workspace's (domainProof.ts): nothing is read until it is.
  const claim = store ? null : await pendingClaim(app, workspaceId);
  return { store, add, read, claim };
}

/** Where the store stands: the first step, and what Today and /start say while it is not done (pages/start.ts). */
export function storeState({ store, add, read, claim = null }: Awaited<ReturnType<typeof setupStoreOf>>): { status: StepStatus; detail: string; job: number | null; verify?: string } {
  const live = [add, read].find((j) => j && LIVE.includes(j.status)) || null;
  if (store?.ingested_at) return { status: 'done', detail: '', job: null };
  if (live) return { status: 'working', detail: 'קוראים את האתר. זה לוקח דקה או שתיים.', job: live.id };
  if (store && !canIngest(store.platform)) return { status: 'attention', detail: `כרגע תורן קורא רק חנויות ${INGESTIBLE_HE}. כתבו לנו.`, job: null };
  // The newest of the two jobs says how the last try ended.
  const last = [add, read].filter(Boolean).sort((a, b) => b!.id - a!.id)[0];
  if (last?.status === 'failed') return { status: 'attention', detail: store ? 'לא הצלחנו לקרוא את האתר. כתבו לנו ונבדוק.' : 'לא הצלחנו לקרוא את האתר. אפשר לנסות שוב, או לכתוב לנו.', job: null };
  if (store) return { status: 'todo', detail: 'האתר עוד לא נקרא.', job: null };
  if (claim) return { status: 'attention', detail: `צריך לאמת שהאתר ${claim.domain} שלכם, ואז תורן קורא אותו. ההוראות בדף הוספת החנות.`, job: null, verify: claim.domain };
  return { status: 'todo', detail: 'כותבים את הכתובת של האתר, ותורן קורא ממנו את המוצרים ואת דפי המדיניות.', job: null };
}

const SOCIAL_TITLE: Record<Social, string> = { messenger: 'מחברים את מסנג׳ר', instagram: 'מחברים את האינסטגרם' };

export async function setupOf(app: App, workspaceId: number): Promise<Setup> {
  const base = publicBase(app.env);
  const at = (p: string) => `${base}${p}`;
  const on = enabledChannels(app.env);
  const found = await setupStoreOf(app, workspaceId);
  const s = found.store;
  const first = storeState(found);
  const steps: Step[] = [
    { key: 'store', title: 'מוסיפים את החנות', status: first.status, detail: first.detail, href: at(s ? `/lead/${s.id}/knowledge` : first.status === 'working' ? '/' : '/start'), required: true },
  ];
  // Each later step: until the store exists, todo with no link.
  const step = async (key: string, title: string, required: boolean, fn: (s: SetupStore) => Promise<Omit<Step, 'key' | 'title' | 'required'>>) => {
    steps.push({ key, title, required, ...(s ? await fn(s) : { status: 'todo' as const, detail: AFTER_STORE, href: null }) });
  };

  await step('knowledge', 'בודקים את התשובות', false, async (s) => {
    const href = at(`/lead/${s.id}/knowledge`);
    if (!s.ingested_at) return { status: 'todo', detail: 'אחרי שהאתר נקרא', href };
    const own = await app.db.one('SELECT 1 FROM faqs WHERE store_id = $1 AND answer IS NOT NULL LIMIT 1', [s.id]);
    if (s.knowledge_seen_at || own) return { status: 'done', detail: '', href };
    return { status: 'todo', detail: 'עוברים על מה שתורן יודע על החנות, ומוסיפים תשובות משלכם.', href };
  });

  await step('whatsapp', 'מחברים את הוואטסאפ', true, async (s) => {
    const href = at(`/lead/${s.id}/whatsapp`);
    const a = await waAccountOf(app, s.id);
    if (a?.status === 'active') return { status: 'done', detail: '', href };
    if (a?.status === 'pending') return { status: 'working', detail: 'המספר ממתין לאישור של Meta. תורן יתחיל לענות בו לבד.', href };
    if (a?.status === 'reconnect') return { status: 'attention', detail: 'החיבור הסתיים. צריך לחבר את המספר מחדש.', href };
    if (a?.status === 'error') return { status: 'attention', detail: 'Meta עצרה את המספר. כתבו לנו ונבדוק יחד.', href };
    if (!waConnectReady(app.env)) return { status: 'soon', detail: 'החיבור של מספר החנות עוד לא פתוח.', href: null };
    return { status: 'todo', detail: 'מחברים את המספר של החנות דרך Meta, והוואטסאפ בטלפון ממשיך לעבוד.', href };
  });

  if (on.has('email')) {
    await step('email', 'מחברים את המייל', false, async (s) => {
      const href = at('/settings#channels');
      const a = await app.db.one("SELECT 1 FROM channel_accounts WHERE store_id = $1 AND channel = 'email' AND status = 'active' LIMIT 1", [s.id]);
      if (a) return { status: 'done', detail: '', href };
      if (!app.mail) return { status: 'soon', detail: 'המייל עוד לא פתוח אצלנו.', href: null };
      return { status: 'todo', detail: 'מעבירים את המייל של החנות לכתובת שתורן עונה ממנה.', href };
    });
  }

  for (const ch of ['messenger', 'instagram'] as const) {
    if (!on.has(ch)) continue;
    await step(ch, SOCIAL_TITLE[ch], false, async (s) => {
      const href = at(`/lead/${s.id}/${ch}`);
      const a = await socialAccountOf(app, s.id, ch);
      if (a?.status === 'active') return { status: 'done', detail: '', href };
      if (a?.status === 'error') return { status: 'attention', detail: 'החיבור נעצר. צריך לחבר שוב.', href };
      if (!socialReady(app.env, ch)) return { status: 'soon', detail: 'החיבור עוד לא פתוח.', href: null };
      return { status: 'todo', detail: ch === 'messenger' ? 'מחברים את הדף של החנות בפייסבוק.' : 'מחברים את חשבון האינסטגרם של החנות.', href };
    });
  }

  await step('orders', 'מחברים את ההזמנות', false, async (s) => {
    const href = at(`/lead/${s.id}/knowledge#orders`);
    if (!ordersPlatform(s.platform)) return { status: 'soon', detail: 'כרגע זה עובד עם Shopify, WooCommerce ו-Wix.', href: null };
    const a = await orderAccessOf(app.db, s.id);
    if (a?.status === 'active') return { status: 'done', detail: '', href };
    if (a) return { status: 'attention', detail: 'המפתח לא עובד. מדביקים מפתח חדש.', href };
    return { status: 'todo', detail: 'מדביקים מפתח שרק קורא הזמנות, ותורן עונה לבד איפה ההזמנה.', href };
  });

  await step('auto', 'מפעילים הודעות אוטומטיות', false, async (s) => {
    const href = at('/settings#auto');
    if (anyOn(await settingsOf(app, s.id))) return { status: 'done', detail: '', href };
    return { status: 'todo', detail: 'תזכורת על עגלה, הודעות על תשלום ומשלוח, ובקשה לביקורת.', href };
  });

  return { product: 'toran', ready: steps.every((x) => !x.required || x.status === 'done'), steps };
}

export function setupRoutes(app: App): Route<Req>[] {
  const refuse: Out = { status: 403, json: { ok: false, error: 'forbidden' } };
  return [
    ['GET', /^\/internal\/setup$/, async (r) => {
      if (!local(app, r)) return refuse;
      const raw = r.url.searchParams.get('workspace') || '';
      const id = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
      if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, json: { ok: false, error: 'bad_workspace' } };
      return { json: await setupOf(app, id), headers: { 'cache-control': 'no-store' } };
    }],
  ];
}
