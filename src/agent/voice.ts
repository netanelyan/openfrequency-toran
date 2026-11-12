import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import type { Db } from '../db/index.ts';
import { J } from '../db/index.ts';
import { audit, usage } from '../db/log.ts';
import { cleanLine, hebrewRatio } from '../core/hebrew.ts';
import { agentModel, OWNER_EFFORT, OWNER_MAX_TOKENS } from './llm/index.ts';
import { capFor } from './spend.ts';
import { firstObject } from '../channels/payCheck.ts';

// How Toran talks in one store (the owner, 2026-11-09: "make sure that toran learns its language from the website, and
// the store owner has a few options for formats of talking. everything should be natural"):
//
//   the profile   learned from the store's own copy (its home page, product descriptions, questions and policies) by one
//                 model call after each read of the site whose copy changed: how formal it is, how it addresses people,
//                 how long its sentences are, its emoji, its own words, its greetings and what it never says, each point
//                 with a short quote from the site, and two sample replies. Kept in stores.config.voice, never facts:
//                 the prompt says the quotes are for tone only. With no model, no copy or a failed call, the store keeps
//                 the profile it had, else the raw sample from the home page (brand.tone) as before.
//   the choice    the owner's, in Settings ("איך תורן מדבר"): "כמו באתר שלכם" (the profile, the default), or one of four
//                 presets, emoji on, off or as the site, and one line of their own. Kept in stores.config.voiceChoice.
//
// The presets' sample replies answer the same question with the same made-up facts, so the owner sees only the voice
// change. Hebrew per the hebrew-voice guide: plain, everyday, no slogans.

export type PresetKey = 'site' | 'warm' | 'short' | 'light' | 'formal';
export type Address = 'plural' | 'neutral';
export type Preset = { he: string; line: string; sample: string | null; address: Address | null; emoji: boolean | null; rules: string };

export const SAMPLE_Q = 'יש לכם את הספל הירוק?';

export const PRESETS: Record<PresetKey, Preset> = {
  site: { he: 'כמו באתר שלכם', line: 'תורן כותב כמו שהחנות כותבת באתר, עם המילים שלה.', sample: null, address: null, emoji: null, rules: "Write the way this store writes on its own site: the VOICE PROFILE below, its words, its length, its warmth. When the profile says little, plain warm everyday Hebrew." },
  warm: { he: 'חם ואישי', line: 'כמו מוכר שמכיר את הלקוחות, עם עוד פרט קטן שעוזר.', sample: 'יש, ואפשר לקבל אותו גם בצבע חול. הוא עולה 89 ₪. לשלוח לכם קישור?', address: 'plural', emoji: false, rules: 'Warm and personal, like a seller who knows the customers: answer, then one small useful detail when the tools have one. Address the customer in the plural (אתם, לכם). Two or three short sentences.' },
  short: { he: 'קצר וענייני', line: 'התשובה וזהו. בלי מילים מיותרות.', sample: 'יש. 89 ₪. לשלוח קישור?', address: 'neutral', emoji: false, rules: 'Short and to the point: the answer in as few words as reads naturally, one or two short sentences, no extras and no small talk.' },
  light: { he: 'קליל', line: 'בגובה העיניים, כמו בצ׳אט עם חבר, ואימוג׳י פה ושם.', sample: 'יש 💚 עולה 89 ₪, ויש גם בחול. לשלוח לינק?', address: 'neutral', emoji: true, rules: 'Light and casual, like a chat with a friend: everyday words (לינק, סבבה when it fits), at most one emoji in a reply and only when it adds something.' },
  formal: { he: 'מכובד', line: 'מנומס ומסודר, בלי סלנג. מתאים לחנות יוקרה או למוצרים מקצועיים.', sample: 'כן, הספל הירוק במלאי, והמחיר שלו 89 ₪. אם תרצו, אשלח לכם קישור להזמנה.', address: 'plural', emoji: false, rules: 'Polite and composed, no slang and no emoji: full sentences, the customer addressed in the plural (אתם, לכם, תרצו). Still plain Hebrew, never bureaucratic.' },
};
export const PRESET_KEYS = Object.keys(PRESETS) as PresetKey[];

export type VoiceProfile = {
  register: 'casual' | 'neutral' | 'formal';
  address: 'plural' | 'neutral' | 'other';
  sentences: 'short' | 'medium' | 'long';
  emoji: { use: 'none' | 'some' | 'often'; which: string[] };
  summary: string;
  points: { what: string; quote: string }[];
  phrases: string[];
  greetings: string[];
  avoid: string[];
  samples: { q: string; a: string }[];
};
export type VoiceChoice = { preset: PresetKey; emoji: 'site' | 'on' | 'off'; note: string; summary?: string };

export const NOTE_MAX = 300;
const COPY_MAX = 6000;

/** The owner's choice, read safely from a store's config. */
export function choiceOf(config: any): VoiceChoice {
  const c = config?.voiceChoice || {};
  const preset = PRESET_KEYS.includes(c.preset) ? (c.preset as PresetKey) : 'site';
  const emoji = c.emoji === 'on' || c.emoji === 'off' ? c.emoji : 'site';
  return { preset, emoji, note: cleanLine(String(c.note || ''), NOTE_MAX), summary: c.summary ? cleanLine(String(c.summary), 600) : undefined };
}

export const profileOf = (config: any): VoiceProfile | null => (config?.voice?.profile && typeof config.voice.profile === 'object' ? config.voice.profile : null);

/** Whether a reply may carry emoji: the owner's switch, else the preset's, else the site's own habit. */
export function emojiOn(config: any): boolean {
  const c = choiceOf(config);
  if (c.emoji !== 'site') return c.emoji === 'on';
  const p = PRESETS[c.preset];
  if (p.emoji !== null) return p.emoji;
  return (profileOf(config)?.emoji.use || 'none') !== 'none';
}

/** How the reply addresses the customer: plural (אתם) only when the preset or the store's own site does. */
export function addressOf(config: any): Address {
  const c = choiceOf(config);
  const p = PRESETS[c.preset];
  if (p.address) return p.address;
  return profileOf(config)?.address === 'plural' ? 'plural' : 'neutral';
}

// ---- The prompt's part

/** The VOICE section of a store's prompt: the preset's rules, the profile (tone only), the owner's line. */
export function voiceBlock(config: any, toneSample: string): string {
  const c = choiceOf(config);
  const p = PRESETS[c.preset];
  const prof = profileOf(config);
  const lines = [`# VOICE (how to write here; never a source of facts)`, `Chosen by the store's owner: "${p.he}". ${p.rules}`];
  lines.push(addressOf(config) === 'plural' ? 'Address the customer in the plural (אתם, לכם, תרצו).' : 'Address the customer in forms that fit everyone ("אפשר", "רוצים ש...", "שולחים לי"), never a gendered singular and never a slash.');
  lines.push(emojiOn(config) ? 'Emoji: allowed, at most one in a reply, only where it adds something.' : 'Emoji: none.');
  if (prof && (c.preset === 'site' || c.summary)) {
    lines.push(`VOICE PROFILE, learned from the store's own site:`);
    lines.push(`- In short: ${c.summary || prof.summary}`);
    lines.push(`- Register: ${prof.register}; sentences: ${prof.sentences}.`);
    for (const pt of prof.points.slice(0, 6)) lines.push(`- ${pt.what} (the site: "${pt.quote}")`);
    if (prof.phrases.length) lines.push(`- Its own words, to use where they fit: ${prof.phrases.map((x) => `"${x}"`).join(', ')}`);
    if (prof.greetings.length) lines.push(`- Its greetings: ${prof.greetings.map((x) => `"${x}"`).join(', ')}`);
    if (prof.avoid.length) lines.push(`- Never: ${prof.avoid.map((x) => `"${x}"`).join(', ')}`);
    if (c.preset === 'site') for (const s of prof.samples.slice(0, 2)) lines.push(`- Example (facts made up): customer "${s.q}", you "${s.a}"`);
  } else if (c.preset === 'site') {
    lines.push(`How this store writes, in its own words (for tone only; facts in it are not to be quoted, they come from the tools):\n"""${toneSample || '(no sample found: write in plain, warm, everyday Hebrew)'}"""`);
  }
  if (p.sample) lines.push(`Example of this voice (facts made up): customer "${SAMPLE_Q}", you "${p.sample}"`);
  if (c.note) lines.push(`The owner adds, about how they talk: "${c.note}"`);
  return lines.join('\n');
}

// The reply's emoji and stacked marks are cut in code by the guard (guard.ts styleReply), with emojiOn() and addressOf().

// ---- Learning the profile

/** The store's own copy, as the profile reads it: the home page's sample and description, products, questions, policies. */
export async function storeCopy(db: Db, storeId: number, brand: any): Promise<string> {
  const parts: string[] = [];
  if (brand?.description) parts.push(`HOME PAGE DESCRIPTION:\n${brand.description}`);
  if (brand?.tone) parts.push(`HOME PAGE:\n${brand.tone}`);
  const products = await db.query<{ title: string; body_text: string }>("SELECT title, body_text FROM products WHERE store_id = $1 AND gone_at IS NULL AND length(body_text) > 80 ORDER BY length(body_text) DESC LIMIT 12", [storeId]);
  const heb = products.filter((p) => hebrewRatio(p.body_text) >= 0.4).slice(0, 6);
  if (heb.length) parts.push(`PRODUCT DESCRIPTIONS:\n${heb.map((p) => `${p.title}: ${p.body_text.slice(0, 400)}`).join('\n')}`);
  const faqs = await db.query<{ question: string; site_answer: string }>('SELECT question, site_answer FROM faqs WHERE store_id = $1 AND site_answer IS NOT NULL ORDER BY id LIMIT 6', [storeId]);
  if (faqs.length) parts.push(`QUESTIONS AND ANSWERS:\n${faqs.map((f) => `${f.question} ${String(f.site_answer).slice(0, 300)}`).join('\n')}`);
  const policies = await db.query<{ kind: string; text: string }>('SELECT kind, text FROM policies WHERE store_id = $1 ORDER BY id LIMIT 3', [storeId]);
  if (policies.length) parts.push(`POLICIES (how they phrase rules):\n${policies.map((p) => `${p.kind}: ${String(p.text).slice(0, 400)}`).join('\n')}`);
  return parts.join('\n\n').slice(0, COPY_MAX);
}

const VOICE_PROMPT = `You read an Israeli online store's own website copy and describe how the store writes, so a chat assistant can answer its customers in the same voice. Describe the voice only: never facts, prices or products.

Answer with one JSON object and nothing else:
{"register": "casual" | "neutral" | "formal",
 "address": "plural" | "neutral" | "other",   // plural: it says אתם/לכם to customers; neutral: it avoids addressing them
 "sentences": "short" | "medium" | "long",
 "emoji": {"use": "none" | "some" | "often", "which": [up to 4 emoji it uses]},
 "summary": "one or two plain Hebrew sentences on how the store sounds",
 "points": [{"what": "an English note on one habit of its writing", "quote": "a short exact quote from the copy that shows it"}],  // 3 to 6
 "phrases": [up to 6 words or short phrases the store itself uses again and again, exactly as written],
 "greetings": [its greetings or sign-offs, exactly as written, if any],
 "avoid": [up to 4 kinds of words that would sound wrong for this store, in Hebrew],
 "samples": [{"q": "a short customer question in Hebrew", "a": "the reply in this store's voice, made-up facts"}]  // exactly 2
}
Every quote and phrase must appear in the copy word for word. The Hebrew in summary and samples is plain everyday Hebrew: no slogans, no em dashes, no "שאלה מצוינת", no "בשמחה!", no "ניתן" or "על מנת".`;

const ONE = (v: unknown, allowed: string[], fallback: string) => (allowed.includes(String(v)) ? String(v) : fallback);
const strs = (v: unknown, n: number, max = 60) => (Array.isArray(v) ? v.map((x) => cleanLine(String(x ?? ''), max)).filter(Boolean).slice(0, n) : []);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The model's answer as a profile, every quote and phrase checked against the copy it read. Null when it is not one. */
export function readProfile(o: Record<string, any> | null, copy: string): VoiceProfile | null {
  if (!o) return null;
  const inCopy = (q: string) => q.length >= 2 && flat(copy).includes(flat(q));
  const summary = cleanLine(String(o.summary || ''), 400);
  const samples = (Array.isArray(o.samples) ? o.samples : []).map((s: any) => ({ q: cleanLine(String(s?.q || ''), 120), a: cleanLine(String(s?.a || ''), 300) })).filter((s: any) => s.q && s.a).slice(0, 2);
  if (!summary || !samples.length) return null;
  return {
    register: ONE(o.register, ['casual', 'neutral', 'formal'], 'neutral') as VoiceProfile['register'],
    address: ONE(o.address, ['plural', 'neutral', 'other'], 'neutral') as VoiceProfile['address'],
    sentences: ONE(o.sentences, ['short', 'medium', 'long'], 'medium') as VoiceProfile['sentences'],
    emoji: { use: ONE(o.emoji?.use, ['none', 'some', 'often'], 'none') as VoiceProfile['emoji']['use'], which: strs(o.emoji?.which, 4, 8).filter((e) => inCopy(e)) },
    summary,
    points: (Array.isArray(o.points) ? o.points : []).map((p: any) => ({ what: cleanLine(String(p?.what || ''), 160), quote: cleanLine(String(p?.quote || ''), 120) })).filter((p: any) => p.what && inCopy(p.quote)).slice(0, 6),
    phrases: strs(o.phrases, 6).filter(inCopy),
    greetings: strs(o.greetings, 3).filter(inCopy),
    avoid: strs(o.avoid, 4),
    samples,
  };
}

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Whether this server learns voices: on wherever a model really answers; in tests only when TORAN_VOICE=on. */
export const voiceOn = (app: App) => String(app.env.TORAN_VOICE || '').trim() !== 'off' && (app.llm.backend !== 'scripted' || String(app.env.TORAN_VOICE || '').trim() === 'on');

/**
 * Learn the store's voice from its copy: one model call, only when the copy changed since the last profile (or `force`).
 * Never throws: a failed or empty answer keeps what the store had. Returns what happened, for the log.
 */
export async function learnVoice(app: App, storeId: number, { force = false }: { force?: boolean } = {}): Promise<'learned' | 'same' | 'off' | 'no_copy' | 'cap' | 'failed'> {
  if (!voiceOn(app)) return 'off';
  const store = await app.db.one<{ id: number; platform: string; brand: any; config: any }>('SELECT id, platform, brand, config FROM stores WHERE id = $1', [storeId]);
  if (!store || store.platform === 'company') return 'off';
  const copy = await storeCopy(app.db, storeId, store.brand);
  if (hebrewRatio(copy) < 0.2 || copy.length < 200) return 'no_copy';
  const hash = hashOf(copy);
  if (!force && store.config?.voice?.hash === hash && profileOf(store.config)) return 'same';
  if (await capFor(app, store)) return 'cap';
  try {
    const res = await app.llm.turn({ system: [{ text: VOICE_PROMPT }], messages: [{ role: 'user', content: `THE STORE'S COPY:\n${copy}` }], tools: [], model: agentModel(app.env), maxTokens: OWNER_MAX_TOKENS, effort: OWNER_EFFORT, tag: `voice store ${storeId}`, timeoutMs: 60_000, maxRetries: 1 });
    await usage(app.db, { storeId, conversationId: null, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag: 'voice' });
    const text = res.content.map((b) => (b.type === 'text' ? String((b as { text: string }).text) : '')).join('\n');
    const profile = readProfile(firstObject(text), copy);
    if (!profile) return 'failed';
    await app.db.query("UPDATE stores SET config = config || jsonb_build_object('voice', $2::jsonb), updated_at = now() WHERE id = $1", [storeId, J({ profile, hash, at: new Date().toISOString() })]);
    return 'learned';
  } catch (e: any) {
    app.log(`[voice] store ${storeId}: not learned, the store keeps its voice: ${cleanLine(String(e?.message || e), 200)}`);
    return 'failed';
  }
}

/** The owner's choice, saved: the preset, emoji and their line (each cut to its size). */
export async function saveChoice(db: Db, storeId: number, form: Record<string, any>, by: string): Promise<VoiceChoice> {
  const choice = choiceOf({ voiceChoice: { preset: form.preset, emoji: form.emoji, note: form.note, summary: form.summary } });
  await db.query("UPDATE stores SET config = config || jsonb_build_object('voiceChoice', $2::jsonb), updated_at = now() WHERE id = $1", [storeId, J(choice)]);
  await audit(db, { actor: by, action: 'voice', storeId, detail: { preset: choice.preset, emoji: choice.emoji, note: Boolean(choice.note), summary: Boolean(choice.summary) } });
  return choice;
}
