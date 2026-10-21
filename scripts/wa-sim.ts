// npm run wa:sim -- [--phone 972500000101]
//
// Be a phone writing to the demo number, without WhatsApp: every line you type goes through the real router (codes,
// bindings, the agent, the guard, the footer), with the simulated provider in place of Twilio. Paste a store's
// DEMO-XXXX first, then ask. "/phone <number>" switches to another phone, to check that two phones on two stores
// never cross. "/exit" quits.

import { createInterface } from 'node:readline';
import { makeApp } from '../src/app.ts';
import { simProvider } from '../src/wa/providers.ts';
import { handleInbound } from '../src/wa/router.ts';

const args = process.argv.slice(2);
let phone = args.includes('--phone') ? args[args.indexOf('--phone') + 1].replace(/\D/g, '') : '972500000101';
const app = await makeApp({ quiet: true, wa: simProvider() });
let n = 0;
console.log(`You are +${phone}. Paste a DEMO-XXXX code to bind to a store. /phone <number> to switch, /exit to quit.\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `+${phone}> ` });
rl.prompt();
for await (const line of rl) {
  const text = line.trim();
  if (text === '/exit') break;
  const sw = /^\/phone\s+(\d+)/.exec(text);
  if (sw) {
    phone = sw[1];
    rl.setPrompt(`+${phone}> `);
  } else if (text) {
    const r = await handleInbound(app, { from: phone, text, id: `sim-${Date.now()}-${n++}` });
    const out = app.wa.outbox!.filter((o) => o.to === phone).at(-1);
    console.log(`  [${r.action}${r.storeId ? `, store ${r.storeId}` : ''}]\n${out ? out.text.split('\n').map((l) => `  ${l}`).join('\n') : '  (no reply)'}\n`);
  }
  rl.prompt();
}
rl.close();
await app.db.close();
