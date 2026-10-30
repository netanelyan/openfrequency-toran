// The one interface between the agent loop and a model. The loop speaks the Messages
// API's shapes (text, tool_use and tool_result blocks); each backend maps them to its
// transport:
//
//   api         the Anthropic API through the official SDK, with prompt caching (production)
//   claude-cli  the Claude Code CLI on the owner's subscription (development, evals):
//               tools are described in the prompt and called through a JSON answer
//   scripted    a function, for tests

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
/** Blocks a backend returns that the loop passes back untouched within a turn (thinking). */
export type OpaqueBlock = { type: string; [k: string]: unknown };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

/** A system part. cache: the prompt-cache breakpoint after it ('1h' for the shared prompt and the store's block). */
export type SystemPart = { text: string; cache?: '1h' | '5m' };

export type TurnReq = {
  system: SystemPart[];
  messages: Msg[];
  tools: ToolDef[];
  model: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  tag?: string;
  /** This call's own limits (the agent's turn passes them: a customer is waiting). Absent: the client's defaults. */
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
};

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cache_write_1h?: number; cache_write_5m?: number };

export type TurnRes = {
  content: Block[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | string;
  usage: Usage;
  model: string;
  backend: 'api' | 'claude-cli' | 'scripted';
  usd: number; // paid for this call
  apiUsd: number; // what the same call costs on the API (equal to usd on the API)
};

export interface Llm {
  backend: 'api' | 'claude-cli' | 'scripted';
  turn(req: TurnReq): Promise<TurnRes>;
}

export class LlmError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

export const isToolUse = (b: Block): b is ToolUseBlock => b.type === 'tool_use';
export const isText = (b: Block): b is TextBlock => b.type === 'text';
export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
