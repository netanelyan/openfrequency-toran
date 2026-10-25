# Toran (תורן)

A Hebrew-first agent that answers, sells and follows up on an Israeli online store's own WhatsApp number. Part
of the OpenFrequency family, beside Teder.

This repository is **phase 1, the demo machine**:

1. Find Israeli online stores.
2. Build each one a pitch page with a working WhatsApp demo of the agent answering as that store.
3. Let the owner review and approve the page, then send the link by hand.
4. Watch what happens next.

Nothing in it contacts a store or a customer by itself.

```
lead discovery -> dedupe + platform detection -> score -> ingest -> knowledge pack -> pitch page + demo code
-> owner review -> owner sends the link by hand -> store opens the page -> taps the WhatsApp demo
-> the router binds their phone to that store -> the agent answers as the store -> events -> dashboard
```

The audit that chose this stack is [docs/audit.md](docs/audit.md), the decisions are in
[docs/decisions.md](docs/decisions.md), and what each milestone delivered and how it was tested is in
[docs/milestones.md](docs/milestones.md).

## Try it

```sh
npm install
npm test          # offline: the fictional store, an in-memory Postgres, a scripted model
npm run demo      # the dashboard and a pitch page for the fictional store on http://localhost:4711
                  # (a stand-in for openfrequency-accounts signs you in); --live runs the real agent on your Claude Code login
```

## Run it for real

```sh
npm run init-private                   # private/.env, the database (PGlite in private/data until DATABASE_URL is set)
npm run leads -- find --source storecensus --from-page 20 --pages 5     # discovery
npm run leads -- list                  # the qualified leads, best first
npm run leads -- show <domain>         # one lead's score, factor by factor
npm run ingest -- <domain> --verify    # its knowledge pack, prices checked against each product's own page
npm run chat -- <domain>               # talk to its agent in the terminal (on the subscription in development)
npm run eval -- <domain>               # 30 questions from its own data, graded in code
npm run company -- sync <export.json>  # our own support store, from openfrequency-web's `npm run support` (docs/company.md)
npm start                              # the dashboard, pitch pages, webhook and worker on :4710
```

The dashboard does the same from a browser: add a store by URL, review and correct its pack, approve its page,
copy the message, mark it sent, see the chats.

## Where things are

| | |
|---|---|
| `src/leads` | discovery sources (StoreCensus, Brave, seed file, links between stores), detection, scoring, dedupe |
| `src/ingest` | a store's catalogue (Shopify's feed, WooCommerce's Store API, Wix's and Cashcow's product pages; a sitemap and JSON-LD when there is no feed), policies, FAQ and brand (the logo's colour when the site names none) into one knowledge pack; local embeddings |
| `src/agent` | the one agent loop, its six tools, the prompt, the reply guard, the model backends |
| `src/pitch` | the pitch page, its sample chat, its tracking |
| `src/wa` | the WhatsApp demo router and the BSP providers (Twilio, a simulator) |
| `src/ops` | the operator's dashboard: who to write to today, the conversations, the funnels, the money (docs/operator.md) |
| `src/owners` | the owner line: one WhatsApp number for business owners, about Toran and Teder (docs/owner-line.md) |
| `src/company.ts` | a company store: Toran answering our own support from the site's export (docs/company.md) |
| `src/web` | the dashboard (Teder's look), auth, the public routes |
| `src/jobs` | a Postgres job queue and its worker (WhatsApp messages, ingest, the daily re-scrape) |
| `src/brand.ts` | the family's marks and tokens; `assets/brand/` holds the files |
| `deploy/` | Postgres with pgvector in Docker Compose, the pm2 job, the host Caddy block; see docs/deploy.md |

## The public repo, the private folder

The repository is public. Anything about real stores, leads, conversations, keys or phone numbers lives in
`private/` (gitignored) or the database. The pre-commit hook runs `npm run check:public`, which refuses:

- keys of every known shape
- databases and media outside the allowed folders
- any phone number that is not a fictional `050-000-0xxx`
- the domain or name of every real store the engine has touched (it writes them to `private/known-stores.txt`
  as it goes)

The only stores in the repository are fictional: `kli-cheres.example` (Shopify), `tavlinim-ba-shuk.example` and
`beit-hasabon.example` (WooCommerce, with and without its Store API), `quiet-candles.example` (Wix),
`noa-example.wixsite.com/shop` (a free Wix site under a path) and `etz-tzaatzuim.example` (Cashcow). All but the
first keep the shapes of responses recorded from real stores, with every name, address and price made up (`examples/`).
