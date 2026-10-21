# Milestone 0: the audit

What the three earlier projects do well, what Toran takes from each, what it rewrites, and the debt it leaves
behind. Read on 2026-10-21 from `netanelyan/tiyul-plus`, `netanelyan/tiyul-social` and `netanelyan/openfrequency`
(Teder). Nothing private from any of them is quoted here.

## tiyul-plus: the AI layer

**What it does well.** The design rule that runs through the whole codebase is *when the model ignores a rule,
don't phrase the rule harder; move it to where it is not a choice*. Concretely:

- **The reply guard** (`src/lib/priceGuard.ts`) is a deterministic filter on every reply. It splits the reply into
  sentences, and any sentence that carries a price, an availability claim or a superlative whose numbers the
  traveller did not say themselves is replaced with an honest line, once per category. This is the most valuable
  piece in the three repos for Toran.
- **Prompt caching** is done carefully: tools and the shared prompt are a byte-identical prefix with a 1-hour
  breakpoint; per-turn state never goes into `system`. History is trimmed in steps of 10 so the cached prefix stays
  stable, and there are tests that pin "never change the tool list per turn".
- **Facts instead of rules.** The model is handed precomputed counts and statuses. Tool results carry the rules
  that matter at that moment ("quote only the prices above"), because the last thing the model reads wins.
- **Tools that cannot lie.** `booking_search` has no price field at all; the server builds the link.
- **Hebrew matching** (`hebrewMatch.ts`): word boundaries that know Hebrew prefixes, each rule from a real false
  positive. **Cost accounting** (`aiCost.ts`) prices 5-minute and 1-hour cache writes separately.

**What is weak.**

- `src/app/api/chat/route.ts` is about 2,000 lines, and its `runAgent` is a 1,000-line closure with about 15
  mutable flags.
- Intent detection is a pile of incident-driven Hebrew regexes.
- In-memory rate limits on serverless. Spend writes are fire-and-forget.
- The client sends the history and the server trusts it.
- The guard's allowlist is "numbers the user said", so a price the model read correctly from a tool is still cut.
  That is right for a travel app that holds no prices, and wrong for a store.
- There is no C# AI layer: it is TypeScript calling the API with raw `fetch`. The stack question did not come up.

**Toran takes:**

- the guard's mechanism (`sentenceEnds`, once-per-category replacement, colon continuation, self-passing
  replacement lines)
- `heWord` and `cleanLine`
- the caching layout and its rules
- the cost table idea
- "facts not rules" and rules inside tool results
- tools without free-text price or discount fields

**Toran rewrites:**

- **The guard's allowlist** becomes *the numbers in this conversation's tool results plus the customer's own*. Its
  categories become a store's: price, stock, delivery time, discount/refund/promise, and policy.
- **The loop** becomes one small module (`src/agent/loop.ts`) with one interface to three model backends. History
  lives on the server.
- **Off-topic handling** goes to the prompt plus the eval, not to regexes.

## tiyul-social: the lead finder

**What it does well.**

- **Search and injection:** discovery uses the Brave Search API, because Google CSE is closed to new customers and
  Bing's API ended in 2025. Every network call is injected, so the self-test runs the pipeline offline.
- **Dedupe:** multi-key (site, phone, social id), with permanent `seen` and do-not-contact lists.
- **Budget:** a ledger with a guard *before* each paid call, not after.
- **Never sends:** there is no POST to any social host in the allowlist, and the self-test fails the build if one
  appears. The dashboard only copies a message and opens the contact.
- **Follow-ups:** one only, enforced in code.

**What is weak.**

- **Storage and scoring:** a single JSON file rewritten on every action. The score is stored as a total plus prose
  "why" lines, with no per-factor breakdown.
- **Fetching:**
  - no robots.txt, no retry, fixed sleeps instead of a per-host limiter, and search results are not cached
  - the size cap is checked against content-length only, so a chunked body is read whole
  - the site key is the hostname, so `shop.x.co.il` and `x.co.il` are two leads
  - contact extraction takes only the first `mailto:` and misses `wa.me/message/...` and chat widgets
  - Hebrew detection is "3 Hebrew letters"

**Toran takes:**

- the dedupe model (keys, permanent seen list)
- the injected-deps pipeline
- the budget-guard pattern
- one-follow-up-then-stop
- the copy-and-open outreach button
- the Brave client shape

**Toran rewrites:**

- the fetcher (`src/core/http.ts`): robots.txt, per-host spacing, a streaming size cap, typed failures
- domain canonicalisation to the registrable domain (`tldts`, which knows `co.il`)
- contact extraction: every email, `wa.me` and `api.whatsapp.com` links, and widget markers
- Hebrew as a letter ratio plus `lang`/`dir`
- the score as `{factor, points, max, evidence}[]`, stored
- storage in Postgres

## open-frequency (Teder): the owner site and the repo pattern

**What it does well.**

- **The owner site:**
  - It is server-rendered strings with one stylesheet and one progressive-enhancement script, and works without JS.
  - It is a family look: Apple-style frosted glass over a silver wallpaper, the system font, one blue button per
    decision, colour only for meaning.
  - It is RTL with logical properties, and phone-first: a floating glass top capsule and tab bar on a phone, a
    glass sidebar on a desk.
- **The approval flow:**
  - a card with Approve (blue) / Edit / Reject and a reason
  - ajax with the card animating out and a toast
  - approve-all that posts the explicit ids it showed
  - a two-tap confirm for anything irreversible
- **Auth:** scrypt passwords, an HMAC-signed session cookie, CSRF from the session, Origin and Host checks, a login
  limiter, a strict CSP.
- **The public-repo pattern:** a gitignored `private/` folder, and a pre-commit `check:public` that reads the git
  index and refuses keys, databases, media and the names of real accounts.
- **The model door:**
  - `askJson()` runs on the Claude Code CLI on the subscription in development and on the API in production.
  - API calls are refused in development unless allowed.
  - The CLI child is stripped of `ANTHROPIC_*` so it cannot bill the key.

**What is weak, for a sibling.**

- `net.js` HARD RULE 1 forbids WhatsApp and Meta writes outright, and that is Toran's whole job.
- `pages.js` is a 923-line monolith wired to Teder's domain.
- There are duplicated CSS rules for the account menu, and a dead theme toggle.
- Background jobs live in an in-memory `Map`, so they are lost on restart.
- SQLite is fine for one process, but Toran has a webhook, a worker and a dashboard at once, plus vector search.

**Toran takes:**

- `style.css` nearly whole (tokens, glass recipe, components), with the account-menu duplicates and the dead theme
  rules dropped
- the `ui` helpers (`esc`, the icon sprite, `layout`, `postButton`, `statusChip`, tokens-not-dollars)
- `app.js` (confirm, toggle, ajax remove, toast, dev-tap)
- `auth` verbatim in TypeScript
- the server's checks and the flash/ajax pattern
- `paths`/`env`
- `check-public` and the hook
- the CLI model backend

**Toran rewrites:**

- the pages for leads
- **the approval flow becomes a lead review queue**: a card per store waiting for review, with the pitch preview, the
  knowledge pack's flagged rows, Approve / Edit / Skip
- a Postgres job queue instead of the in-memory map

## Where it lives: a separate repo

The default was `apps/toran` inside open-frequency. I am proposing the separate `openfrequency-toran` repo (it
already exists, empty), for three reasons:

1. **Opposite network rules.** Teder's engine forbids DMs and WhatsApp as a hard rule, and Toran's purpose is a
   WhatsApp agent. In one repo, one of them weakens the other's guarantee.
2. **Different private data.** Teder's `check:public` denylist is built from its packs; Toran's private data is
   stores, phone numbers and customer chats. Mixed in one repo, each check has to know the other's secrets.
3. **Little code to share.** The shared surface is about six files (the stylesheet, the UI helpers, auth, env, the
   public check, the CLI backend). Copying them once and letting each product evolve costs less than a shared
   package with two release cycles.

The family resemblance comes from the copied stylesheet and component vocabulary. If the two drift, the stylesheet
is the one file to re-sync.

## The stack

| Piece | Choice | Why, and the trade-off |
|---|---|---|
| Language | TypeScript, run directly by Node 24 (type stripping), no build step; `tsc --noEmit` checks types | Your default, without a bundler. Teder's no-build simplicity stays. |
| Web | `node:http`, server-rendered HTML strings, Teder's stylesheet and script | **Not Next.js.** The dashboard has to look like Teder, and Teder is plain HTML + one CSS + one script with a strict CSP. Porting it to React would mean rebuilding the look rather than reusing it. Pitch pages are static HTML that must load fast on a phone, which needs no framework. |
| Database | Postgres + pgvector in production (Docker Compose, `pgvector/pgvector:pg17`). **PGlite** (Postgres in WASM, with its pgvector extension) in development and tests | Same SQL and migrations everywhere. Nothing to install on the laptop (this machine has no Docker or Postgres). Tests get a fresh in-memory database each. |
| Jobs | A `jobs` table, claimed with `FOR UPDATE SKIP LOCKED` | **No Redis or BullMQ in phase 1.** About 20 stores, a daily re-scrape and a few hundred webhook turns a day fit a table, and that removes one service from the VPS. BullMQ is a drop-in later if volume demands it. |
| Model | The official `@anthropic-ai/sdk` with prompt caching in production. The **Claude Code CLI on your subscription** in development and evals (headless, `--tools ""`, `--json-schema`, `ANTHROPIC_*` stripped), measured at about 5 s a turn. A scripted backend in tests | Development and the 30-question evals cost nothing per call. In development the API is refused unless a command asks for it. |
| Embeddings | `multilingual-e5-small` (384 dimensions) run locally with transformers.js | $0 per call, works offline on the VPS, and ranked the right Hebrew policy passage first in all three test queries. |
| Search API | Brave Search API | Google's Custom Search JSON API is closed to new customers, and Bing's API was retired in 2025. |
| HTML | cheerio | Robust on real-world store HTML, where regexes are not. |
| Deploy | Docker Compose: postgres + app (web, webhook and worker in one process) + Caddy | Your default. Compose files are written but **not run on this machine** (no Docker here). |

## The WhatsApp BSP: Twilio for phase 1

The facts that decide it:

- **Meta's fees.** Every demo conversation is started by the store owner (they tap the button and send the code),
  so every Toran reply is a *service* message in the 24-hour window. **Meta charges nothing for those.** The only
  cost is the BSP's own fee.
- **360dialog** charges a flat €49/month per number (Regular tier) with no per-message markup.
- **Twilio** charges $0.005 per message, inbound and outbound, with no monthly fee. It accepts an Israeli number
  you own via Bring Your Own Number, verified by SMS or voice OTP. Its sandbox can be used today without Meta
  approval.

At phase 1 volume (20 pitches, say 20 messages each, so about 800 messages a month), Twilio costs about **$4 a
month** against 360dialog's **€49**. Twilio's per-message fee only passes 360dialog's flat fee at about 10,000
messages a month, which is a phase 2 problem.

The router is written against a two-function provider interface (parse an inbound, send a reply), so moving to
360dialog or straight to Meta's Cloud API later is one file.

**What I could not verify from here:** whether Twilio will register a +972 sender for your business without a
regulatory bundle. Its docs speak to SMS in Israel, not WhatsApp. If it balks, 360dialog onboards Israeli numbers
routinely, and the adapter swap is small.

## Tech debt that would hurt Toran if copied

- Teder's in-memory job map: an ingest started from the dashboard would vanish on restart.
- tiyul-social's JSON-file store, and its hostname-based dedupe.
- tiyul-plus's monolithic route, and its trust in client-sent history.
- Teder's network rules, which forbid the WhatsApp API.
- No robots.txt anywhere. Toran visits strangers' sites, so it reads robots.txt.

## Folder layout

```
openfrequency-toran/
  src/
    core/      paths, env, clock, hebrew, urls, http (the polite fetcher)
    db/        the Postgres/PGlite door, migrations/*.sql, the event/audit/usage ledgers
    jobs/      the Postgres queue and its worker
    leads/     discovery sources (StoreCensus, Brave, seed file, crawl), detection, scoring, dedupe
    ingest/    Shopify feed -> product rows; policies, brand, FAQ; embeddings; the daily re-scrape
    agent/     prompt, tools, the loop, the reply guard, cost; llm/ (api, claude-cli, scripted)
    wa/        the demo-code router and the BSP providers (twilio, sim)
    pitch/     the pitch page and its sample chat
    web/       server, auth, ui, pages, static/ (style.css, app.js, pitch.css, pitch.js)
  scripts/     one entry point per npm script
  test/        node:test, offline, PGlite in memory, the fictional store
  examples/    the fictional store (the only store data in the repo)
  deploy/      docker-compose.yml, Dockerfile, Caddyfile.example
  docs/        this audit, decisions, the bot page, milestone reports, screenshots of the fictional store
  private/     gitignored: .env, the PGlite database, models, eval transcripts, known-stores.txt
```
