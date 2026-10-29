import type { Block, Llm, Msg, TurnReq, TurnRes } from './types.ts';
import { emptyUsage } from './types.ts';

// The test backend: a function from the request to the answer's blocks. Tests pass
// their own script to drive the loop down a path (a tool call, an invented price the
// guard must cut, a handoff). The default script is a deterministic little agent for
// the offline demo: it looks things up, then quotes the first line the tool returned.

export type Script = (req: TurnReq, call: number) => Block[] | Promise<Block[]>;

const lastUser = (messages: Msg[]) => [...messages].reverse().find((m) => m.role === 'user');
const blocksOf = (m: Msg | undefined): Block[] => (!m ? [] : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);

export const defaultScript: Script = (req) => {
  const blocks = blocksOf(lastUser(req.messages));
  const results = blocks.filter((b) => b.type === 'tool_result') as { content: string }[];
  if (results.length) {
    const text = String(results[0].content);
    // A product line: "- [id 12] title: 89 ₪, במלאי, 3 options. https://..."
    const product = /^- \[id \d+\] (.+?): (.+?), (במלאי|אזל מהמלאי)/m.exec(text);
    if (product) return [{ type: 'text', text: `${product[3] === 'במלאי' ? 'כן, יש במלאי.' : 'כרגע זה לא במלאי.'} ${product[1]} עולה ${product[2]}. רוצים שאשלח קישור?` }];
    // A policy passage: its first sentence with substance.
    const passage = text.split('\n').find((l) => l.trim().length > 20 && /[א-ת]/.test(l) && !/^(From the store|Rule:|No products|What this store)/.test(l));
    if (passage && !/has not written/.test(text)) return [{ type: 'text', text: passage.trim() }];
    return [{ type: 'text', text: 'את זה אני לא יודע. אני בודק עם החנות, ואחזור אליך כאן.' }];
  }
  // The customer's text is the last text block: the app's SERVER CONTEXT rides in its own block before it.
  const text = (blocks.filter((b) => b.type === 'text').pop() as { text?: string } | undefined)?.text || '';
  const q = text.replace(/^SERVER CONTEXT[\s\S]*?\n\n/, '').trim();
  if (/משלוח|החזר|החלפ|תשלום|ביט|אספקה|מגיע/.test(q)) return [{ type: 'tool_use', id: `s_${Date.now()}`, name: 'get_policy', input: { topic: q } }];
  return [{ type: 'tool_use', id: `s_${Date.now()}`, name: 'search_products', input: { query: q } }];
};

export function scriptedClient(script: Script = defaultScript): Llm {
  let calls = 0;
  return {
    backend: 'scripted',
    async turn(req: TurnReq): Promise<TurnRes> {
      const content = await script(req, calls++);
      return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: emptyUsage(), model: 'scripted', backend: 'scripted', usd: 0, apiUsd: 0 };
    },
  };
}
