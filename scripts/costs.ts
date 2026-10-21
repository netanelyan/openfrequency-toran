// npm run costs: what each store has cost so far, and what a demo costs.
// "model" is what the calls cost at API prices (in development the subscription answered them, so nothing was
// paid); "paid" is what was paid (the API in production, Twilio, Brave).

import { makeApp } from '../src/app.ts';

const app = await makeApp({ quiet: true });
const rows = await app.db.query<any>(`
  SELECT s.domain,
    COALESCE(SUM(u.api_usd) FILTER (WHERE u.kind = 'llm'), 0)::float AS model,
    COALESCE(SUM(u.usd), 0)::float AS paid,
    COALESCE(SUM(u.in_tokens + u.cache_read + u.cache_write) FILTER (WHERE u.kind = 'llm'), 0)::int AS tin,
    COALESCE(SUM(u.out_tokens) FILTER (WHERE u.kind = 'llm'), 0)::int AS tout,
    COALESCE(SUM(u.units) FILTER (WHERE u.kind = 'bsp'), 0)::int AS msgs,
    (SELECT COUNT(*)::int FROM conversations c WHERE c.store_id = s.id) AS convs,
    (SELECT COUNT(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.store_id = s.id AND m.role = 'agent') AS answers
  FROM stores s JOIN usage u ON u.store_id = s.id GROUP BY s.id ORDER BY model DESC`);
console.log('store                          model $   paid $   answers  $/answer   tokens in/out      WA msgs');
for (const r of rows) console.log(`${r.domain.padEnd(30)} ${r.model.toFixed(3).padStart(7)} ${r.paid.toFixed(3).padStart(8)} ${String(r.answers).padStart(9)} ${(r.answers ? r.model / r.answers : 0).toFixed(4).padStart(10)}   ${String(r.tin).padStart(8)}/${String(r.tout).padEnd(7)} ${String(r.msgs).padStart(6)}`);
const t = rows.reduce((a: any, r: any) => ({ model: a.model + r.model, answers: a.answers + r.answers }), { model: 0, answers: 0 });
console.log(`\n${t.answers} answers, $${t.model.toFixed(3)} at API prices: $${(t.answers ? t.model / t.answers : 0).toFixed(4)} an answer. A demo of 8 questions: about $${(8 * (t.answers ? t.model / t.answers : 0)).toFixed(2)}.`);
await app.db.close();
