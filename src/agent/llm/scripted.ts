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
    const lines = String(results[0].content).split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^(rules|כללים)/i.test(l));
    const first = lines.find((l) => /₪|\d/.test(l)) || lines[0] || '';
    return [{ type: 'text', text: first ? `מצאתי את זה אצלנו: ${first.replace(/^[-•]\s*/, '')}` : 'אין לי תשובה בטוחה לזה, אז העברתי את השאלה לבעל החנות.' }];
  }
  const text = (blocks.find((b) => b.type === 'text') as { text?: string } | undefined)?.text || '';
  const q = text.replace(/^SERVER CONTEXT[\s\S]*?\n\n/, '').trim();
  if (/משלוח|החזר|החלפ|תשלום|ביט|אספקה/.test(q)) return [{ type: 'tool_use', id: `s_${Date.now()}`, name: 'get_policy', input: { topic: q } }];
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
