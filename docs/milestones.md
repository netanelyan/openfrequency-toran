# Phase 1, milestone by milestone

For each milestone: what changed, the files, how it was tested, what is still weak. The numbers from real stores
come from runs on the development machine. The stores themselves are named only in `private/` (this file is
public).

## 0. The audit

**What changed:** [audit.md](audit.md) covers what tiyul-plus, tiyul-social and open-frequency each do well,
what Toran took and rewrote, and the stack. [decisions.md](decisions.md) keeps the reasons.

**Decisions:**
- **A separate repo**, because Teder's engine forbids WhatsApp writes.
- **Node 24 TypeScript with no build step.**
- **Teder's server-rendered dashboard**, not Next.js.
- **Postgres + pgvector**, with PGlite in development and tests.
- **A Postgres job queue**, not Redis.
- **The agent on the Claude Code subscription in development** and on the API in production.
- **Local embeddings.**
- **Twilio as the BSP:** about $4 a month at phase 1 volume, against 360dialog's €49.

## Brand

**What changed:**
- `assets/brand/` holds the zip as it came.
- `src/brand.ts` exports `toranMark(size)`, `ofMark(size)` (the small halftone at 48px and below) and the
  tokens, served as `/static/brand.css`.
- Favicon, app icons and a manifest (תורן, he, rtl).
- `/brand` behind the login.

**Tested:** a test checks the marks' colours and shapes, and that OpenFrequency switches to the small halftone at
48px. Screenshots: `docs/screenshots/brand-*`.

## 1. The lead finder

**What changed:** `src/leads/*` covers the sources (StoreCensus, Brave, the seed file, links between stores),
detection, the score with its stored breakdown, and dedupe.

**Tested:**
- 8 tests, offline on the fictional store.
- Live runs: StoreCensus pages 1-3, 4-33 and 20-29, then the crawl frontier.
- Result: **94 stores, 41 qualified** (the gate was 20). Every lead keeps its factor-by-factor breakdown.
- The first run qualified three big chains, which led to the -25 chain rule.
- One adult-products store led to the restricted-category check.

**Still weak:**
- **No Brave key yet**, so search discovery has not run live.
- **Branch locators are only found when the home page shows them.** One national brand still qualifies; the review
  queue is where you skip it.
- **About 20% of candidates failed** during two network outages on this machine. They are retried a day later
  (or now, with `leads forget-failed`).

## 2. Shopify ingest

**What changed:** `src/ingest/*` turns a store into product rows, chunked and embedded policies, FAQ, and brand
(two colours, logo, tone). Owner overrides survive a re-scrape. verifyPrices() checks against
`/products/<handle>.js`.

**Tested:** 6 tests offline.

The gate: 5 real Israeli Shopify stores ingested with `--verify`:

| Store | Products | Policy pages | Prices checked | Match |
|---|---|---|---|---|
| A | 96 | 8 | 12 | 12 |
| B | 58 | 7 | 10 | 10 |
| C | 57 | 4 | 12 | 12 |
| D | 26 | 7 | 12 | 12 |
| E | 40 | 6 | 12 | 12 |

**58 of 58 sampled prices match.** One store's robots.txt disallows `/policies/`; that is respected, and its
policy pages were found through its own links instead.

**Still weak:**
- **Ingest is slow on this machine's network:** 30 to 340 seconds a store, at one request a second per host.
- **FAQ extraction finds questions only where the site marks them up** (accordions, headings ending in "?").
- **Brand colours come from theme settings and CSS.** A store whose brand is only in its logo image gets a neutral
  graphite.

## 3. The agent

**What changed:**
- `src/agent/*`: the loop, the six tools, the two-part cached prompt, the guard, the three model backends.
- `npm run chat` and `npm run eval`.

**Tested:**
- 16 agent and guard tests, including an invented price that must never reach the customer, and a model that loops.
- The gate: the 30-question eval on the 5 stores, on the subscription. The results are below.

**The gate: passed.** 150 questions on 5 real stores, through the real loop on the subscription, graded in code. Per store, 30 questions:
- prices, stock and details of real products
- products the store does not carry
- shipping, returns and payment
- unknowns, an order status, discount and refund pressure
- off-topic chat, English, and a prompt injection

The first run scored 147/150, with no invented price. All three failures were investigated and fixed:
- an unknown that answered from nearby passages without handing off (now a rule in get_policy's result)
- two questions about shipping fees sold as line items (the generator now picks merchandise only)

| Store | Passed | Invented prices shown | Invented before the guard | Unknowns escalated | $/question (API prices) |
|---|---|---|---|---|---|
| A | 30/30 | 0 | 0 | 8/8 | 0.030 |
| B | 30/30 | 0 | 0 | 8/8 | 0.032 |
| C | 30/30 (rerun) | 0 | 0 | 8/8 | 0.025 |
| D | 30/30 (rerun) | 0 | 1, cut | 8/8 | 0.029 |
| E | 30/30 (rerun) | 0 | 0 | 8/8 | 0.027 |

The one price "invented before the guard" was a correct price sentence in English that said "1 month" for the tool's Hebrew "חודש". The guard cut it, safely but needlessly. Numbers with a non-money unit are now quantities.

**Cost.** 247 real answers came to $7.17 at API prices, about $0.029 an answer on Opus 5.5. An eight-question demo is about $0.23 before production's prompt caching, plus about $0.08 of Twilio.

**Still weak:**
- **Opus 5.5 answers in two calls, about 15 seconds on the CLI.** The API is faster, and Sonnet 5.5 would be half the price: TORAN_MODEL_AGENT.
- **The guard is lexical.** A claim made without any number ("returns are free") is held by the prompt and the tool rules, not by code. Since 2026-10-25 a claim check holds the common kinds in code (decisions.md, "the guard checks claims").

## 4. The pitch page

**Rebuilt on 2026-10-22** in the Teder look, as OpenFrequency ("we"), with a two-turn sample chat, the price from
one setting, a publish gate for missing fields and a takedown link. See the last entry in
[decisions.md](decisions.md). What follows is the first version.

**What changed:** `src/pitch/*`, `pitch.css` and `pitch.js`.
- **The letter:** first person, the store's own facts, what does not work yet.
- **The sample chat:** the real agent, on a real product.
- **Colour:** the store's own on the chat and its initial; Toran green only on the demo button.
- **Tracking:** opens, scroll depth and demo taps; the owner's own visits are not counted.

**Tested:** web tests cover noindex, the theme, the demo link and code, open counting and beacons. Screenshots on
phone and desk, light and dark: `docs/screenshots/pitch-*`, on the fictional store.

**The real stores:** the 5 ingested stores have pages built, each with a sample chat the real agent wrote about
one of their products: correct prices, sale prices, sizes and colours from the rows. Building them found and fixed
two things:
- one store's sample landed on a shipping fee sold as a product (fees are now excluded)
- the quoted policy line was a company-registration header or a bare "1." (the quote is now the store's own
  sentence about a cost, a time or a return window)
Their screenshots are in `private/screenshots/` only.

**Still weak:**
- **The gate ("3 pages I would send without edits") is yours to judge.** The 5 pages wait in the dashboard's review
  queue.
- **Your contact line stays a visible `[פרטי קשר]`** until TORAN_OWNER_WHATSAPP or TORAN_OWNER_EMAIL is set.

## 5. The WhatsApp demo number

**What changed:**
- `src/wa/*`: the router, and the Twilio and simulator providers.
- `src/jobs/*`: the queue and the worker.
- The webhook, and the monthly spend cap.

**Tested:**
- 5 tests, including the gate: two phones, two stores, one number, no crossover.
- Also: a new code overwrites the binding, expiry, an unknown phone, a bad code, a duplicate delivery, the owner's
  phone, and Twilio's signature.

**Not done here:** a real number. It needs your Twilio account and an Israeli number (docs/deploy.md); the router
is tested through the simulator.

## 6. The owner dashboard

**What changed:** `src/web/pages/*`.
- Today, leads, a lead's page, the review queue and edit screen, chats, follow-ups, settings.
- Add-by-URL as a job, with a page that follows its progress.
- `npm run demo`.

**Tested:**
- 5 web tests: login, every page, CSRF and Origin, the funnel from approval through the one reminder (not on
  Shabbat, never a second), and the webhook.
- The gate path (URL in, approved, ready-to-send page out) runs through the dashboard alone.
- Screenshots: `docs/screenshots/*`.

**Still weak:**
- The edit screen lists 40 products at a time, with a search.
- On a phone the page preview sits at the bottom of the edit screen.
