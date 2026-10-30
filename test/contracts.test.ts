import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { INTERNAL_TOKEN } from './helpers.ts';
import { serve } from './serve.ts';

// The contracts between accounts, Teder and Toran (openfrequency-accounts docs/contracts, PRA-QA-003), held against
// Toran. test/fixtures/contracts is accounts' folder copied byte for byte (its README.md says how the files read and
// what each side owes). Here:
//   - the copy is accounts' own, when accounts' checkout is beside this one;
//   - every case of every API Toran serves (servedBy has "toran") is asked of Toran's real route, from this machine
//     with the internal token as accounts sends it, and its answer must have the case's status and the shape of its
//     body: the same keys and JSON types at every level (a list's every element against the example's first; a field
//     the case calls nullable may be null), and the case's error code when it has one; where a contract's notes leave
//     a body to the product (the delete's 200), LEEWAY says how far. A case Toran cannot be made to give is listed in
//     NOT_HERE with the reason; a case with neither a run nor a reason fails;
//   - the X-OF-Operator header accounts signs (admin-toran-operator.json) is taken by Toran as the case has it.
// Where Toran's real answer and the contract differ and the contract's doc does not settle which side is wrong, the
// difference is written in DISAGREES, exactly: the test holds it to that until one side changes, and then the entry
// has to go (or change), so a fix on either side cannot pass unseen.

type Answer = { case: string; status: number; body: any; nullable?: string[] };
type ContractRoute = { method: string; path: string; answers: Answer[] };
type Contract = { name: string; doc: string; servedBy: string[]; calledBy: string[]; kind?: string; routes: ContractRoute[] };

const DIR = path.join(ROOT, 'test', 'fixtures', 'contracts');
const contracts: Record<string, Contract> = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))]),
);

// ---- the copy

/** The files a contracts folder holds: every contract and its README. */
const filesOf = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json') || f === 'README.md').sort();

/**
 * accounts' contracts beside this checkout: walking up from this repo's root (6 levels at most), the first
 * openfrequency-accounts found, its main checkout's docs/contracts, else each of its worktrees' (.claude/worktrees/*).
 * `paired` is accounts' worktree of this checkout's own name, when this checkout is a worktree (.claude/worktrees/<name>)
 * and accounts has one so named: one change to a contract in flight on both sides, before either is merged.
 */
function accountsContracts(): { main: string | null; worktrees: string[]; paired: string | null } | null {
  const ours = path.basename(path.dirname(ROOT)) === 'worktrees' && path.basename(path.dirname(path.dirname(ROOT))) === '.claude' ? path.basename(ROOT) : null;
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    const accounts = path.join(dir, 'openfrequency-accounts');
    if (!existsSync(accounts)) continue;
    const main = path.join(accounts, 'docs', 'contracts');
    const trees = path.join(accounts, '.claude', 'worktrees');
    const worktrees = existsSync(trees) ? readdirSync(trees).map((w) => path.join(trees, w, 'docs', 'contracts')).filter((d) => existsSync(d)).sort() : [];
    const paired = ours ? worktrees.find((d) => path.basename(path.dirname(path.dirname(d))) === ours) || null : null;
    return { main: existsSync(main) ? main : null, worktrees, paired };
  }
  return null;
}

/** How our copy differs from the folder `dir`, as lines; [] when every file is byte-identical and none is missing. */
function copyDiffers(dir: string): string[] {
  const ours = filesOf(DIR);
  const theirs = filesOf(dir);
  const out = [
    ...theirs.filter((f) => !ours.includes(f)).map((f) => `${f}: in accounts, not copied here`),
    ...ours.filter((f) => !theirs.includes(f)).map((f) => `${f}: here, not in accounts`),
  ];
  for (const f of ours.filter((x) => theirs.includes(x))) {
    if (!readFileSync(path.join(DIR, f)).equals(readFileSync(path.join(dir, f)))) out.push(`${f}: not byte-identical to accounts'`);
  }
  return out;
}

test("the contracts here are accounts' own: test/fixtures/contracts is byte-identical to openfrequency-accounts docs/contracts when that checkout is beside this one", (t) => {
  assert.ok(filesOf(DIR).includes('README.md') && Object.keys(contracts).length > 0, 'the copy is here');
  const found = accountsContracts();
  // The main checkout's is accounts' word once merged; until then, the copy must be one of its worktrees' as a whole. A
  // worktree here with a namesake in accounts (one change on both sides) is held to that one's.
  const sources = found ? (found.paired ? [found.paired] : found.main ? [found.main] : found.worktrees) : [];
  if (!sources.length) {
    t.diagnostic('no openfrequency-accounts checkout with docs/contracts beside this one: the copy is not compared (as in CI)');
    return;
  }
  const results = sources.map((dir) => ({ dir, differs: copyDiffers(dir) }));
  const same = results.find((r) => !r.differs.length);
  assert.ok(same, `test/fixtures/contracts is not accounts' docs/contracts; copy the files again:\n${results.map((r) => `${r.dir}\n  ${r.differs.join('\n  ')}`).join('\n')}`);
  t.diagnostic(`byte-identical to ${same.dir}`);
});

// ---- the shape of an answer

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** What a case leaves to the product: fields that may be null, objects whose keys are its own, places it may add keys. */
type Leeway = { nullable?: string[]; own?: string[]; open?: string[] };

/**
 * Where `actual` does not have the shape of `example`, as lines; [] when it does: the same keys and JSON types at every
 * level, every element of a list against the example's first, null where the example is null or the key is in
 * `nullable`. A key in `own` is an object whose keys are all the product's own: only its values' types are compared.
 * At a path in `open` ("$" is the body) the contract's keys must be there, and keys beside them are the product's own.
 */
export function shapeProblems(actual: unknown, example: unknown, leeway: Leeway = {}, at = '$'): string[] {
  const { nullable = [], own = [], open = [] } = leeway;
  const key = at.split('.').at(-1)!;
  if (actual === null) return example === null || nullable.includes(key) ? [] : [`${at}: null where the contract has ${kind(example)}`];
  if (example === null) return nullable.includes(key) ? [] : [`${at}: ${kind(actual)} where the contract has null`];
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) return [`${at}: ${kind(actual)} where the contract has array`];
    return example.length ? actual.flatMap((a, i) => shapeProblems(a, example[0], leeway, `${at}[${i}]`)) : [];
  }
  if (typeof example === 'object') {
    if (kind(actual) !== 'object') return [`${at}: ${kind(actual)} where the contract has object`];
    const a = actual as Record<string, unknown>;
    const e = example as Record<string, unknown>;
    if (own.includes(key)) {
      const types = new Set(Object.values(e).map(kind));
      return Object.entries(a).filter(([, v]) => !types.has(kind(v))).map(([k, v]) => `${at}.${k}: ${kind(v)} where the contract's are ${[...types].join(' or ')}`);
    }
    const want = Object.keys(e).sort();
    const got = Object.keys(a).sort();
    const extra = open.includes(at) ? [] : got.filter((k) => !want.includes(k));
    const missing = want.filter((k) => !got.includes(k));
    return [
      ...(extra.length ? [`${at}: ${extra.join(', ')} here, not in the contract`] : []),
      ...(missing.length ? [`${at}: ${missing.join(', ')} in the contract, missing here`] : []),
      ...want.filter((k) => got.includes(k)).flatMap((k) => shapeProblems(a[k], e[k], leeway, `${at}.${k}`)),
    ];
  }
  return kind(actual) === kind(example) ? [] : [`${at}: ${kind(actual)} where the contract has ${kind(example)}`];
}

test('the shape check itself: keys at every level, types, nulls where allowed, every element of a list, a product\'s own keys', () => {
  assert.deepEqual(shapeProblems({ a: 1, b: null, c: [{ d: 'x' }, { d: 'y' }] }, { a: 2, b: 'y', c: [{ d: 'z' }] }, { nullable: ['b'] }), []);
  assert.deepEqual(shapeProblems({ a: 1 }, { a: 1, b: 2 }), ['$: b in the contract, missing here']);
  assert.deepEqual(shapeProblems({ a: 1, z: 0 }, { a: 1 }), ['$: z here, not in the contract']);
  assert.deepEqual(shapeProblems({ a: '1' }, { a: 1 }), ['$.a: string where the contract has number']);
  assert.deepEqual(shapeProblems({ a: null }, { a: 1 }), ['$.a: null where the contract has number']);
  assert.deepEqual(shapeProblems({ c: [{ d: 'z' }, { d: 1 }] }, { c: [{ d: 'z' }] }), ['$.c[1].d: number where the contract has string']);
  assert.deepEqual(shapeProblems({ deleted: { stores: 1, files: 0 } }, { deleted: { accounts: 1, posts: 40 } }, { own: ['deleted'] }), []);
  assert.deepEqual(shapeProblems({ deleted: { stores: '1' } }, { deleted: { accounts: 1 } }, { own: ['deleted'] }), ['$.deleted.stores: string where the contract\'s are number']);
  assert.deepEqual(shapeProblems({ ok: true, workspace: 4, deleted: {} }, { ok: true, deleted: {} }, { open: ['$'] }), [], 'keys of its own beside the contract\'s');
  assert.deepEqual(shapeProblems({ workspace: 4, deleted: {} }, { ok: true, deleted: {} }, { open: ['$'] }), ['$: ok in the contract, missing here'], 'but none of the contract\'s missing');
  assert.deepEqual(shapeProblems({ a: { z: 1 } }, { a: {} }, { open: ['$'] }), ['$.a: z here, not in the contract'], 'open only where it says');
});

// ---- the APIs Toran serves: every case asked of the real route

type S = Awaited<ReturnType<typeof serve>>;
type Got = { status: number; json: any };

const WRONG = 'wrong-token-wrong-token-wrong-token-00';
const got = async (r: Response): Promise<Got> => ({ status: r.status, json: await r.json().catch(() => null) });
/** A request as accounts sends it, from this machine: the bearer token (none with null) and a JSON body. */
const ask = (s: S, method: string, p: string, token: string | null = INTERNAL_TOKEN, body?: unknown) =>
  fetch(`${s.base}${p}`, {
    method,
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(got);
/** The same request, asked with OF_INTERNAL_TOKEN unset here and with it 5 characters long. */
async function unsetHere(s: S, call: () => Promise<Got>): Promise<Record<string, Got>> {
  const was = s.app.env.OF_INTERNAL_TOKEN;
  try {
    delete s.app.env.OF_INTERNAL_TOKEN;
    const unset = await call();
    s.app.env.OF_INTERNAL_TOKEN = 'short';
    return { 'OF_INTERNAL_TOKEN unset': unset, 'OF_INTERNAL_TOKEN of 5 characters': await call() };
  } finally {
    s.app.env.OF_INTERNAL_TOKEN = was;
  }
}
const badToken = async (call: (token: string | null) => Promise<Got>) => ({ 'no token': await call(null), 'a wrong token': await call(WRONG) });

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
/** A store row, as the operator's pipeline leaves it. */
async function store(s: S, domain: string, cols: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { domain, url: `https://${domain}/`, name: domain.split('.')[0], platform: 'shopify', source: 'seed', slug: `${domain.split('.')[0]}-c1`, score: 50, qualified: true, ...cols };
  const keys = Object.keys(all);
  const row = await s.app.db.one<{ id: number }>(`INSERT INTO stores (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(all));
  return row!.id;
}
/** A workspace's store with a chat and a message in it. */
async function customerStore(s: S, workspace: number, domain: string) {
  const id = await store(s, domain, { source: 'signup', workspace_id: workspace });
  const conv = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', '972500000600') RETURNING id", [id]))!.id;
  await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'שלום')", [conv]);
  return id;
}

const DEL = 'workspaces-delete /internal/workspaces/<workspace id>/delete';
const SETUP = 'setup /internal/setup';
const OPS = 'toran-ops /internal/ops';
const ACT = 'toran-ops /internal/ops/<toran|teder>/<id>/<action>';
const del = (s: S, id: number, token: string | null = INTERNAL_TOKEN) => ask(s, 'POST', `/internal/workspaces/${id}/delete`, token, {});
const setup = (s: S, ws: number, token: string | null = INTERNAL_TOKEN) => ask(s, 'GET', `/internal/setup?workspace=${ws}`, token);
const ops = (s: S, token: string | null = INTERNAL_TOKEN) => ask(s, 'GET', '/internal/ops', token);
const act = (s: S, p: string, body: unknown, token: string | null = INTERNAL_TOKEN) => ask(s, 'POST', `/internal/ops/${p}`, token, body);
const readyStore = (s: S, domain: string) => store(s, domain, { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: '972500000316' });

/** Each case, by "<contract> <path> :: <case>": its state made and asked, as one or more labelled requests. */
const RUN: Record<string, (s: S) => Promise<Record<string, Got>>> = {
  [`${DEL} :: deleted`]: async (s) => (await customerStore(s, 42, 'mine.example'), { 'a workspace with a store, a chat and a message': await del(s, 42) }),
  [`${DEL} :: nothing of that workspace here (never seen, or deleted already)`]: async (s) => {
    await customerStore(s, 43, 'gone.example');
    await del(s, 43);
    return { 'never seen': await del(s, 9999), 'deleted already': await del(s, 43) };
  },
  [`${DEL} :: no token, or the wrong one`]: (s) => badToken((token) => del(s, 42, token)),
  [`${DEL} :: OF_INTERNAL_TOKEN unset or short here`]: (s) => unsetHere(s, () => del(s, 42)),

  [`${SETUP} :: the checklist (Toran)`]: async (s) => {
    await s.app.db.query('UPDATE stores SET workspace_id = 7 WHERE id = $1', [s.seeded.storeId]);
    return { 'a brand-new workspace': await setup(s, 41), 'a workspace whose store is read': await setup(s, 7) };
  },
  [`${SETUP} :: no token, or the wrong one`]: (s) => badToken((token) => setup(s, 41, token)),
  [`${SETUP} :: OF_INTERNAL_TOKEN unset or short here`]: (s) => unsetHere(s, () => setup(s, 41)),

  // Every list with elements: those of the case's example (a store that tried the demo, a page with no contact, a
  // request stuck on a site whose page was not built, a conversation with its next step), and two that Toran gives every
  // day: a request whose site was never read (no store) and a lead just marked "they answered" (no next step's text).
  [`${OPS} :: the dashboard`]: async (s) => {
    await store(s, 'galil-shoes.example', { status: 'demo_started', approved_at: ago(200), page_built_at: ago(200), sent_at: ago(100), demo_started_at: ago(5), contact_whatsapp: '972500000201' });
    await store(s, 'plants-home.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), score: 64 });
    await store(s, 'wix-store.example', { platform: 'wix' });
    await s.app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-CNTRC1', 'https://wix-store.example/', 'wix-store.example', '972500000204', $1)", [ago(6)]);
    await s.app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-CNTRC2', 'https://unread.example/', 'unread.example', '972500000206', $1)", [ago(2)]);
    await store(s, 'bakery.example', { status: 'pilot', approved_at: ago(300), page_built_at: ago(300), sent_at: ago(250), replied_at: ago(48), next_step: 'לקבוע שיחה', next_step_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), contact_whatsapp: '972500000205' });
    const answered = await store(s, 'answered.example', { status: 'sent', approved_at: ago(300), page_built_at: ago(300), sent_at: ago(250), contact_whatsapp: '972500000207' });
    assert.equal((await act(s, `toran/${answered}/replied`, { by: 'Admin' })).status, 200);
    return { 'the dashboard': await ops(s) };
  },
  [`${OPS} :: no token, or the wrong one`]: (s) => badToken((token) => ops(s, token)),
  [`${OPS} :: OF_INTERNAL_TOKEN unset or short here`]: (s) => unsetHere(s, () => ops(s)),

  [`${ACT} :: recorded: Toran's line for it`]: async (s) => ({ 'sent, on a page ready to send': await act(s, `toran/${await readyStore(s, 'send-me.example')}/sent`, { by: 'Admin' }) }),
  [`${ACT} :: refused by Toran's rules: its own line`]: async (s) => {
    const id = await readyStore(s, 'twice.example');
    await act(s, `toran/${id}/sent`, { by: 'Admin' });
    return { 'sent a second time': await act(s, `toran/${id}/sent`, { by: 'Admin' }) };
  },
  [`${ACT} :: no token, or the wrong one`]: async (s) => {
    const id = await readyStore(s, 'nobody.example');
    return badToken((token) => act(s, `toran/${id}/sent`, { by: 'Admin' }, token));
  },
  [`${ACT} :: OF_INTERNAL_TOKEN unset or short here`]: async (s) => {
    const id = await readyStore(s, 'unset.example');
    return unsetHere(s, () => act(s, `toran/${id}/sent`, { by: 'Admin' }));
  },
};

/** The cases Toran cannot be made to give, and why. */
const NOT_HERE: Record<string, string> = {
  [`${SETUP} :: the checklist (Teder)`]: "Teder's answer (product \"teder\"): Teder's contracts test asks it of Teder's route",
  [`${DEL} :: no such route: a failure, accounts deletes nothing`]: 'what a product without the route answers; Toran has the route, so its real route never gives it (accounts\' test holds its client to failing on it)',
};

/**
 * Where Toran's real answer differs from the contract, exactly as the check finds it. When one side changes, the entry
 * goes. accounts' clients read none of the difference: they ignore unknown keys and treat any status but the right one
 * as a failure.
 *
 * The refusals of /internal/setup, /internal/ops and the workspace delete answer as the contracts say since 2026-10-30
 * (src/ops/api.ts internalRefusal, and src/erase.ts: 401 bad_token, 503 not_configured, the same as Teder's); until then
 * setup and ops answered 403 forbidden to all of them, and the delete's refusals carried an ok: false.
 */
const DISAGREES: Record<string, string[]> = {
  // The dashboard also carries the job queue's counts (src/ops/api.ts opsData; the queue is in Toran's
  // docs/operator.md section 6), which /admin does not show. Since 2026-10-30 the contract has our number and the demo
  // line, and lets a conversation's next_step (a lead just marked "they answered") and a stuck request's storeId (a
  // site never read) be null, as accounts' reader (its src/web/toran.js readOps) always took them.
  [`${OPS} :: the dashboard`]: ['$: jobs here, not in the contract'],
};

/**
 * Where a contract leaves an answer's body to the product. workspaces-delete's notes: "The body of a 200 is the
 * product's own count of what it deleted; accounts reads only the status." So a 200's ok and deleted must be there, the
 * counts in deleted are the product's own (Toran's are stores, conversations, messages...; the example's are Teder's),
 * and the body may say more beside them (Toran's says which workspace). Its refusals are held to the contract as usual.
 */
const LEEWAY: Record<string, { status: number; own: string[]; open: string[] }> = { 'workspaces-delete': { status: 200, own: ['deleted'], open: ['$'] } };

/** How an answer differs from a case, as lines: the status, the body's shape, and the error code when the case has one. */
function differences(g: Got, a: Answer, contract: string): string[] {
  const code = a.body?.error;
  const left = LEEWAY[contract]?.status === a.status ? LEEWAY[contract] : null;
  return [
    ...(g.status === a.status ? [] : [`status ${g.status} where the contract has ${a.status}`]),
    ...shapeProblems(g.json, a.body, { nullable: a.nullable || [], own: left?.own || [], open: left?.open || [] }),
    // A code, not a line in Hebrew (toran-ops' 400 is Toran's own words): it must be the same.
    ...(typeof code === 'string' && /^[a-z_]+$/.test(code) && g.json?.error !== code ? [`error ${JSON.stringify(g.json?.error ?? null)} where the contract has ${JSON.stringify(code)}`] : []),
  ];
}

const served = Object.entries(contracts).filter(([, c]) => c.servedBy.includes('toran'));
const caseKeys = served.flatMap(([name, c]) => c.routes.flatMap((r) => r.answers.map((a) => `${name} ${r.path} :: ${a.case}`)));

test('Toran serves at least the workspace delete, the setup checklist and the dashboard, and every entry here names one of their cases', () => {
  for (const name of ['workspaces-delete', 'setup', 'toran-ops']) assert.ok(served.some(([n]) => n === name), name);
  for (const key of [...Object.keys(RUN), ...Object.keys(NOT_HERE), ...Object.keys(DISAGREES)]) assert.ok(caseKeys.includes(key), `${key}: no such case in the contracts`);
  for (const key of Object.keys(NOT_HERE)) assert.ok(!RUN[key] && !DISAGREES[key], `${key}: listed as not asked, and asked`);
});

for (const [name, c] of served) {
  describe(`contract ${name}, served by Toran`, () => {
    let s: S;
    before(async () => {
      s = await serve();
      // Teder's demos (src/ops/sources.ts) are asked of the stand-in for accounts, which has none: no request leaves.
      s.app.env.TEDER_SITE_INTERNAL = `http://127.0.0.1:${s.accounts.port}`;
    });
    after(async () => s?.close());
    for (const r of c.routes) {
      for (const a of r.answers) {
        const key = `${name} ${r.path} :: ${a.case}`;
        if (NOT_HERE[key]) {
          test(`${key}: not asked of Toran: ${NOT_HERE[key]}`, () => assert.ok(!RUN[key]));
          continue;
        }
        test(key, async () => {
          assert.ok(RUN[key], `no run for ${key}: every case of a route Toran serves is asked of the real route, or listed in NOT_HERE with the reason`);
          const want = DISAGREES[key] || [];
          for (const [variant, g] of Object.entries(await RUN[key](s))) {
            const why = want.length
              ? `${key} (${variant}): differs from the contract as recorded in DISAGREES; a side changed, so change or remove the entry`
              : `${key} (${variant}): ${JSON.stringify(g.json).slice(0, 600)}`;
            assert.deepEqual(differences(g, a, name), want, why);
          }
        });
      }
    }
  });
}

// ---- the header accounts signs and Toran reads

test('admin-toran-operator :: the payload of X-OF-Operator: the case, signed as accounts signs it (60 seconds ahead), is the operator on a page under /admin/toran; without it, sign in', async () => {
  const c = contracts['admin-toran-operator'];
  assert.ok(c.calledBy.includes('toran') && c.kind === 'header');
  const [a] = c.routes[0].answers;
  const s = await serve();
  try {
    s.as('');
    const payload = Buffer.from(JSON.stringify({ ...a.body, exp: Date.now() + 60_000 })).toString('base64url');
    const header = `${payload}.${createHmac('sha256', INTERNAL_TOKEN).update(payload).digest('base64url')}`;
    const ADMIN = { 'x-of-admin-prefix': '/admin/toran' };
    assert.equal((await s.get('/admin/toran/leads', { ...ADMIN, 'x-of-operator': header })).status, 200, 'the case, as accounts signs it');
    assert.equal((await s.get('/admin/toran/leads', ADMIN)).status, 303, 'no header, no session: sent to sign in');
    // The refusals (expired, a bad signature, a changed payload, no ses) are in paywall.test.ts, built from this case.
  } finally {
    await s.close();
  }
});
