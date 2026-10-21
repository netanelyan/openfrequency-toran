# Decisions

Each entry gives what was decided, the alternatives, and why. Newest at the bottom.

## 2026-10-21: a separate repository, not apps/toran

**Alternatives:** a folder inside open-frequency.

**Why:**

- Teder's network rules forbid WhatsApp writes, and that is Toran's whole job.
- The two products' private data differ, and so do their public checks.
- The shared code is about six files, which were copied (see audit.md).

## 2026-10-21: no Next.js, no Redis

**Alternatives:** Next.js for the dashboard and pitch pages; BullMQ on Redis for jobs.

**Why:**

- The dashboard must look like Teder, which is server-rendered strings, one stylesheet and one script under a
  strict CSP. Reusing that beats re-creating it in React.
- Pitch pages are static HTML for phones.
- Phase 1 job volume fits a Postgres table with `SKIP LOCKED`, one service fewer to run.

## 2026-10-21: PGlite for development and tests

**Alternatives:** require Docker or a Postgres install on the laptop; SQLite in development.

**Why:**

- PGlite is real Postgres compiled to WASM, with the pgvector extension, so the migrations, the queries and
  `<=>` are identical to production.
- This machine has no Docker. Tests get an in-memory database each, in milliseconds.

## 2026-10-21: the agent runs on the subscription in development

**Alternatives:** the API everywhere.

**Why:**

- You asked for development and testing on the Claude Code subscription. The CLI headless call
  (`--tools "" --json-schema --system-prompt`) was measured at about 5 s a turn with structured tool calls.
- The agent loop and tools are the same in both backends. Only the transport differs: the CLI backend asks for
  `{reply | tool_calls}` as JSON and the loop runs the tools itself.
- In development the API backend is refused unless a command is run with `--allow-api` (Teder's rule).

## 2026-10-21: the model

**Alternatives:** Sonnet 5.5 ($2/$10 per MTok) or Haiku 4.5 ($1/$5) for lower cost.

**Decision:** `claude-opus-5-5` by default ($4 in, $20 out, $0.20 cache reads), at effort `low`, set in
`TORAN_MODEL_AGENT`.

**Why:**

- This is a sales demo in Hebrew where one wrong answer loses the store.
- The cost log records every call per store from day one, so the price of a demo is measured, not guessed. If it is
  too high, switching to Sonnet 5.5 is one setting.
- Chat at effort `low` is where the Claude docs say quality holds.

## 2026-10-21: local embeddings

**Alternatives:** Voyage or another paid embeddings API.

**Why:**

- `multilingual-e5-small` runs on the VPS's CPU at $0.
- It handles Hebrew, and on three test questions it ranked the right policy passage first.
- Policy text per store is small, so quality at this size is enough. Prices never come from embeddings anyway.

## 2026-10-21: Twilio as the BSP for phase 1

**Alternatives:** 360dialog (€49 a month per number); Meta's Cloud API directly.

**Why:**

- Demo replies are service messages, which Meta does not charge for.
- Twilio's $0.005 a message comes to about $4 a month at phase 1 volume, and its sandbox works today.
- The provider is one file behind an interface.
