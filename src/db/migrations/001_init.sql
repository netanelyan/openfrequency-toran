-- Toran, phase 1: the demo machine. One store is one lead is one tenant.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- stores: the lead and the tenant in one row
-- status is the lead's place in the funnel, in this order:
--   new           found and scored; nothing built yet
--   page_ready    ingested, knowledge pack and pitch page built; waits for the owner's review
--   sent          the owner sent the link by hand and said so
--   opened        the store owner opened the pitch page
--   demo_started  they tapped the WhatsApp demo and wrote to it
--   pilot, paid   the business side
--   skipped       not a fit, or asked not to be contacted; never comes back from discovery
-- approved_at is the review gate: a page_ready lead with approved_at is ready to send.
CREATE TABLE stores (
  id              serial PRIMARY KEY,
  domain          text NOT NULL UNIQUE,          -- canonical registrable domain: shop.example.co.il -> example.co.il
  url             text NOT NULL,                 -- the homepage as found (final URL after redirects)
  name            text,
  platform        text NOT NULL DEFAULT 'unknown', -- shopify | woocommerce | wix | konimbo | magento | other | unknown
  status          text NOT NULL DEFAULT 'new',
  score           integer NOT NULL DEFAULT 0,
  score_breakdown jsonb NOT NULL DEFAULT '[]',   -- [{factor, points, max, evidence}]
  qualified       boolean NOT NULL DEFAULT false,
  reject_reason   text,                          -- why discovery set it aside (not a store, not Hebrew, unreachable)
  signals         jsonb NOT NULL DEFAULT '{}',   -- what detection saw: hebrewRatio, productCount, whatsapp, emails, ...
  source          text NOT NULL,                 -- storecensus | brave | seed | crawl | manual
  source_detail   jsonb NOT NULL DEFAULT '{}',   -- the query, the page or the store it was found from
  contact_email   text,
  contact_whatsapp text,                         -- international digits, 9725XXXXXXXX
  contact_phone   text,
  slug            text UNIQUE,                   -- /s/<slug>
  demo_code       text UNIQUE,                   -- DEMO-XXXX, the WhatsApp binding code
  brand           jsonb NOT NULL DEFAULT '{}',   -- {name, logo, colors:[a,b], tone, description}
  brand_override  jsonb NOT NULL DEFAULT '{}',   -- the owner's edits; survive every re-scrape
  config          jsonb NOT NULL DEFAULT '{}',   -- per-tenant agent config (currency, contact line, extra rules)
  found_at        timestamptz NOT NULL DEFAULT now(),
  ingested_at     timestamptz,
  page_built_at   timestamptz,
  approved_at     timestamptz,
  sent_at         timestamptz,
  opened_at       timestamptz,
  demo_started_at timestamptz,
  followup_due_at timestamptz,
  followup_sent_at timestamptz,                  -- the one reminder; after it, nothing more goes to them
  skipped_at      timestamptz,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stores_status ON stores (status, score DESC);

-- Every key a lead is known by, so a store found twice (two domains, the same email or
-- WhatsApp number) is one lead. key: site:<domain> | email:<addr> | wa:<972...> | phone:<972...>
CREATE TABLE lead_keys (
  key       text PRIMARY KEY,
  store_id  integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE
);

-- Discovery: each run, and the frontier of links between stores still to visit.
CREATE TABLE discovery_runs (
  id          serial PRIMARY KEY,
  source      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats       jsonb NOT NULL DEFAULT '{}',
  error       text
);
CREATE TABLE crawl_frontier (
  url         text PRIMARY KEY,
  domain      text NOT NULL,
  depth       integer NOT NULL DEFAULT 0,
  found_from  text,
  status      text NOT NULL DEFAULT 'todo',      -- todo | done | skipped | failed
  added_at    timestamptz NOT NULL DEFAULT now(),
  visited_at  timestamptz
);
-- Domains seen and rejected: discovery never pays to look at them again.
CREATE TABLE seen_domains (
  domain      text PRIMARY KEY,
  verdict     text NOT NULL,                     -- lead | rejected | failed
  reason      text,
  seen_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- the knowledge pack
-- Products are rows. A price the agent says comes from these rows (through a tool),
-- never from an embedding. override holds the owner's corrections, on top of what was
-- scraped; a re-scrape rewrites the scraped columns and never touches override.
CREATE TABLE products (
  id            serial PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  ext_id        text NOT NULL,                   -- the platform's id
  handle        text,
  title         text NOT NULL,
  vendor        text,
  product_type  text,
  tags          text[] NOT NULL DEFAULT '{}',
  url           text,
  image         text,
  currency      text NOT NULL DEFAULT 'ILS',
  price_min     numeric(12,2),
  price_max     numeric(12,2),
  compare_at_max numeric(12,2),
  available     boolean NOT NULL DEFAULT false,  -- any variant in stock
  variants      jsonb NOT NULL DEFAULT '[]',     -- [{id, title, options, price, compare_at, available, sku}]
  body_text     text NOT NULL DEFAULT '',
  search_text   text NOT NULL DEFAULT '',        -- normalised title, type, tags, vendor, variant titles
  override      jsonb NOT NULL DEFAULT '{}',     -- {title?, price?, available?, hidden?}
  source_updated_at timestamptz,
  scraped_at    timestamptz NOT NULL DEFAULT now(),
  gone_at       timestamptz,                     -- no longer in the store's feed
  UNIQUE (store_id, ext_id)
);
CREATE INDEX products_store ON products (store_id) WHERE gone_at IS NULL;

-- Policies (shipping, returns, payment, contact, other) as the store wrote them, and
-- their chunks with an embedding for get_policy.
CREATE TABLE policies (
  id            serial PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind          text NOT NULL,                   -- shipping | returns | payment | contact | about | other
  title         text NOT NULL,
  url           text,
  text          text NOT NULL,
  override_text text,                            -- the owner's correction replaces text for the agent
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, url)
);
CREATE TABLE chunks (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  policy_id   integer REFERENCES policies(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  text        text NOT NULL,
  embedding   vector(384)
);
CREATE INDEX chunks_store ON chunks (store_id);

-- FAQ: questions found on the site, and a slot for answers the owner adds later.
CREATE TABLE faqs (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  question    text NOT NULL,
  site_answer text,                              -- the answer as the site gives it, when it does
  answer      text,                              -- the owner's answer; the agent prefers it
  source_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The pitch page's own content: the sample chat (made by the real agent on a real
-- product) and the automations shown.
CREATE TABLE pitches (
  store_id      integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  product_id    integer REFERENCES products(id) ON DELETE SET NULL,
  sample_chat   jsonb NOT NULL DEFAULT '[]',     -- [{role, text}]
  automations   jsonb NOT NULL DEFAULT '[]',
  headline      text,
  built_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- WhatsApp demo routing
-- One demo number for every store. A phone that sent DEMO-XXXX is bound to that store
-- for 7 days; a new code overwrites the binding.
CREATE TABLE wa_users (
  phone       text PRIMARY KEY,                  -- international digits
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code        text NOT NULL,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_inbound_at timestamptz                    -- the 24-hour service window is measured from here
);

CREATE TABLE conversations (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel     text NOT NULL,                     -- whatsapp | cli | pitch | eval
  peer        text,                              -- the phone, for whatsapp
  started_at  timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  handoffs    integer NOT NULL DEFAULT 0,
  misses      integer NOT NULL DEFAULT 0,        -- guard redactions and "I don't know" escalations
  closed_at   timestamptz
);
CREATE INDEX conversations_store ON conversations (store_id, last_at DESC);
CREATE INDEX conversations_peer ON conversations (peer, store_id) WHERE peer IS NOT NULL;

CREATE TABLE messages (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,                 -- customer | agent | system
  text            text NOT NULL,                 -- what was shown or sent
  raw_text        text,                          -- the model's text before the guard, when it differs
  tools           jsonb NOT NULL DEFAULT '[]',   -- [{name, input, ok, summary}]
  guard           jsonb NOT NULL DEFAULT '[]',   -- redactions: [{rule, sentence}]
  handoff         jsonb,                         -- {reason, summary} when the agent handed off
  miss            boolean NOT NULL DEFAULT false,
  ext_id          text UNIQUE,                   -- the BSP's message id (idempotency)
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv ON messages (conversation_id, id);

-- ---------------------------------------------------------------- events and costs
-- Everything that happened, for the dashboard and the funnel: page_open, scroll,
-- demo_click, demo_bound, wa_in, wa_out, handoff, miss, ingest, rescrape, discovery...
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  store_id    integer REFERENCES stores(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  visitor     text,                              -- an anonymous per-browser id on the pitch page
  data        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_store ON events (store_id, kind, at DESC);

-- Every billable unit, per store, from day one: LLM tokens, BSP messages, searches.
-- usd is what was paid; api_usd is what the same call would cost on the API (for calls
-- the subscription answered in development), so the cost per demo can be forecast.
CREATE TABLE usage (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  store_id        integer REFERENCES stores(id) ON DELETE SET NULL,
  conversation_id integer REFERENCES conversations(id) ON DELETE SET NULL,
  kind            text NOT NULL,                 -- llm | bsp | search | fetch
  backend         text,                          -- api | claude-cli | scripted | twilio | brave
  model           text,
  in_tokens       integer NOT NULL DEFAULT 0,
  cache_read      integer NOT NULL DEFAULT 0,
  cache_write     integer NOT NULL DEFAULT 0,
  out_tokens      integer NOT NULL DEFAULT 0,
  units           integer NOT NULL DEFAULT 0,    -- messages, searches
  usd             numeric(12,6) NOT NULL DEFAULT 0,
  api_usd         numeric(12,6) NOT NULL DEFAULT 0,
  tag             text
);
CREATE INDEX usage_store ON usage (store_id, at);

-- ---------------------------------------------------------------- jobs: a queue in Postgres
-- No Redis in phase 1: a few hundred jobs a day fit a table, claimed with SKIP LOCKED.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  dedupe_key  text,                              -- one live job per key (e.g. ingest:<store>)
  status      text NOT NULL DEFAULT 'queued',    -- queued | running | done | failed
  run_at      timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at   timestamptz,
  last_error  text,
  progress    text,                              -- a line for the dashboard while it runs
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX jobs_ready ON jobs (status, run_at);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------- the dashboard's own
CREATE TABLE users (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE audit (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text,
  action  text NOT NULL,
  store_id integer,
  detail  jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
