// npm run chat -- <domain|id> [--quiet]
//
// Talk to a store's agent in the terminal, without WhatsApp: the same loop, tools,
// guard and footer the demo number uses, on the Claude Code subscription in
// development. Shows each tool call and what the guard cut. A line "/new" starts a new
// conversation; "/exit" quits.
//
// npm run chat -- <domain|id> --ask "question" [--ask "..."]   one-shot, for scripts

import { createInterface } from 'node:readline';
import { makeApp } from '../src/app.ts';
import { canonicalDomain } from '../src/core/urls.ts';
import { conversationFor, runTurn, type TurnOutput } from '../src/agent/loop.ts';

const args = process.argv.slice(2);
const app = await makeApp({ quiet: true });
const quiet = args.includes('--quiet');
const key = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--ask') || '';
const store = await app.db.one<any>('SELECT id, name, domain, ingested_at FROM stores WHERE id::text = $1 OR domain = $2', [key, canonicalDomain(key)]);
if (!store) {
  console.log('no such store. npm run leads -- list');
  process.exit(1);
}
if (!store.ingested_at) {
  console.log(`${store.domain} has no knowledge pack yet: npm run ingest -- ${store.domain}`);
  process.exit(1);
}

const show = (o: TurnOutput) => {
  if (!quiet) {
    for (const t of o.tools) console.log(`  · ${t.name} ${JSON.stringify(t.input)}${t.ok ? '' : ' (error)'}`);
    for (const r of o.redactions) console.log(`  ✂ guard cut (${r.rule}): ${r.sentence}`);
    if (o.handoff) console.log(`  ↪ handoff (${o.handoff.reason}): ${o.handoff.summary}`);
    console.log(`  [${o.rounds} model call${o.rounds === 1 ? '' : 's'}, ${o.tokens.in + o.tokens.cacheRead + o.tokens.cacheWrite} in / ${o.tokens.out} out tokens, $${o.apiUsd.toFixed(4)} at API prices]`);
  }
  console.log(`\n${store.name}: ${o.reply}\n`);
};

let conv = await conversationFor(app.db, store.id, 'cli', null);
const asks = args.flatMap((a, i) => (a === '--ask' && args[i + 1] ? [args[i + 1]] : []));
if (asks.length) {
  for (const q of asks) {
    console.log(`> ${q}`);
    show(await runTurn(app, { storeId: store.id, conversationId: conv, text: q }));
  }
  await app.db.close();
} else {
  console.log(`Chatting with ${store.name} (${store.domain}) on ${app.llm.backend}. /new for a new conversation, /exit to quit.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text === '/new') {
      conv = await conversationFor(app.db, store.id, 'cli', null);
      console.log('(new conversation)');
    } else if (text) show(await runTurn(app, { storeId: store.id, conversationId: conv, text }));
    rl.prompt();
  }
  rl.close();
  await app.db.close();
}
