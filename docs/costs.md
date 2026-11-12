# What a Toran store costs us

The running costs behind one customer's store, per month, as of 2026-11-08, so the price (₪590 for 300 conversations,
₪1,190 for 1,500, before VAT) can be checked against them. Prices from the providers' own pages on that day; check
them again before relying on them.

| What | Who bills it | How much | Notes |
| --- | --- | --- | --- |
| The model (the agent's answers) | Anthropic, to us | Sonnet 5.5 at high effort (`TORAN_AGENT_EFFORT`, since 2026-11-11): about $0.011 an answer on the fictional store, 1.1 to 1.2 times medium's $0.010 (docs/models.md, measured). Real stores' searches and pages are longer, so theirs cost more; Opus 5.5 at low effort on real stores, before prompt caching, was about $0.029 (docs/milestones.md §3) | A customer's store is held to what its workspace pays: an alert to us at 30% of its month in model costs, the model stopped at 50% (below). Leads, demos and our support store: `TORAN_MONTHLY_CAP_USD` and each one's own cap (src/agent/spend.ts) |
| The model looking at photos | Anthropic, to us | a product's photo the agent looks at (view_product_images): about 550 input tokens on Shopify (asked for 640 pixels wide), up to about 1,600 elsewhere; six photos about $0.007 on Sonnet 5.5 the first time in a turn. A customer's photo: the same, up to four a message. The catalogue's looks (src/ingest/looks.ts): about 140 input and 25 output tokens a product on Shopify, read once a photo, so a 250-product store about $0.15 once | The looks pass skips a store past a cap; `TORAN_LOOKS=off` stops it |
| A store's WhatsApp number | Kapso, to us | Pro plan $25 a month with 3 numbers and 100,000 messages, then $10 a month a number (kapso.com/pricing) | Disconnected three days after a store stops (src/jobs/retention.ts) |
| WhatsApp messages Meta charges for | Meta, to the store | the store's own account (customer_managed billing): answers inside 24 hours of the customer's message are free; templates the store sends first (cart, review: Marketing; payment, shipping: Utility) at Meta's rates for Israel | Our contract says so (openfrequency-web, the Toran contract) |
| Instagram and Messenger | Zernio, to us | the first 2 accounts free, then $6 an account up to 10, $3 up to 100; the first 10,000 sent messages a month free, then $1 per 10,000; received messages free (zernio.com/pricing) | Shared with Teder's Zernio account |
| Email | Resend, to us | within its plan | Toran's own mail and the store's domain |
| Our own number (demo, support, alerts, pitches) | Meta, to us | Marketing and Utility templates at Meta's rates; the demo's answers are free inside 24 hours | One number for all of it |

**A typical store on the store plan**, 300 conversations of about four answers each: about 1,200 answers, about $14 of
model at the fictional store's cost an answer (docs/models.md), $36 at the $0.03 real stores cost before caching, plus
its share of Kapso ($10, or less while under Pro's three numbers), plus Zernio's $3 to $6 an account if Instagram and
Messenger are connected. Well under the ₪590 a month, and the setup fee covers the first day's reading and the two
weeks of reading conversations with the owner.

**Sight and thought (2026-11-09), and high effort (2026-11-11).** The owner asked for it "even if ai costs double",
then "even if toran costs 1.5x themselves". The cost of the effort is measured now (docs/models.md: medium, high,
xhigh and Opus 5.5 on the same twelve conversations); the photos' numbers above are still estimates from the token
rules (a photo is about width x height / 750 tokens), not measurements. Check both on real stores from the `usage`
rows: tag `agent` per answer, tag `looks` per store. `TORAN_AGENT_EFFORT=medium` puts the answers back where they were.

## What a customer's store may cost us (2026-11-11)

The owner: "make sure there is a cap where if ai costs of an account reach 30% of the payment of the customer, we get
alerted. them on 50% it stops." Each customer's workspace, each Israel month (src/agent/spend.ts): the usage of all its
stores in dollars (a claude-cli call at its API price), in shekels at `USD_ILS` (3.17 unless set; the Bank of Israel's
rate on 2026-11-11 was 3.172), against what a month of Toran costs it before VAT (accounts' `monthlyIls`, else the
plan's list price).

| Plan | Pays a month, before VAT | The alert, 30% | The stop, 50% |
| --- | --- | --- | --- |
| חנות, 300 conversations | 590 ₪ | 177 ₪ ($55.84) | 295 ₪ ($93.06) |
| חנות גדולה, 1,500 conversations | 1,190 ₪ | 357 ₪ ($112.62) | 595 ₪ ($187.70) |

At 30% we get one alert that month on WhatsApp. At 50% the model stops for every store of the workspace until the
month ends: a customer's message gets the honest "checking" line and goes to the owner, who reads only that Toran
passed it on and gets one email and a line on Today in the terms' words, and we get one alert; the store's page
(/admin/toran/lead/<id>#cost) lifts it for the rest of the month, audited. At the measured $0.011 an answer a full
store plan is about 7% and a full big plan about 18%; at the $0.03 of real stores before caching, 19% and 48%. Leads,
demos and our support store are held to `TORAN_MONTHLY_CAP_USD` instead, which no longer counts or stops a customer's
store (docs/operator.md, section 6).

What is not known yet, and should be measured on the first real stores: the real number of answers per
conversation, the prompt cache's share in production, and Meta's template volume per store.
