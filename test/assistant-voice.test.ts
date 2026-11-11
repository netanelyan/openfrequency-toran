import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { ask } from '../src/assistant/index.ts';
import { channelHe, who } from '../src/assistant/data.ts';
import { scriptedClient } from '../src/agent/llm/scripted.ts';
import type { TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

// The owner's assistant names a customer as the inbox does and keeps the customers' voice rules (the audit of
// 2026-11-12, P1-24): "לקוח בweb (…4821)" was a site chat visitor, its browser's random id cut like a phone, and its
// replies kept the dashes and the call-centre words the customers' prompt bans.

test('a customer is named by the channel\'s Hebrew name, with a part of a phone or an address only', () => {
  assert.equal(who('web', 'Abcdefghijklmnopq4821'), 'לקוח בצ׳אט באתר');
  assert.equal(who('messenger', '27390012345678901'), 'לקוח במסנג׳ר', 'Meta\'s id means nothing to the owner');
  assert.equal(who('instagram', '17841400000000123'), 'לקוח באינסטגרם');
  assert.equal(who('whatsapp', '972500000123'), 'לקוח בוואטסאפ (…0123)');
  assert.equal(who('email', 'dana@example.test'), 'לקוח במייל (da…@example.test)');
  assert.equal(channelHe('web'), 'צ׳אט באתר');
});

test("the assistant's answer keeps the voice rules: no dash as a sentence break, and its prompt says so", async () => {
  const app = await testApp();
  try {
    await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
    const storeId = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
    await ingestStore(app, storeId);
    let system = '';
    app.llm = scriptedClient((req: TurnReq) => {
      system = req.system.map((p) => p.text).join('\n');
      return [{ type: 'text', text: 'היום היה שקט — אין שאלות שמחכות לכם.' }];
    });
    const reply = await ask(app, { storeId, text: 'מה קרה היום?', via: 'dashboard', author: 'נורית' });
    assert.equal(reply, 'היום היה שקט, אין שאלות שמחכות לכם.');
    assert.match(system, /No dashes \(— or –\) as sentence breaks/);
    assert.match(system, /no ניתן, במידה ו, על מנת/);
    assert.match(system, /the chat on the store's website/, 'the site chat is one of the channels Toran answers on');
  } finally {
    await app.db.close();
  }
});
