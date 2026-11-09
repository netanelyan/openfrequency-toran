# What a Toran store costs us

The running costs behind one customer's store, per month, as of 2026-11-08, so the price (₪590 for 300 conversations,
₪1,190 for 1,500, before VAT) can be checked against them. Prices from the providers' own pages on that day; check
them again before relying on them.

| What | Who bills it | How much | Notes |
| --- | --- | --- | --- |
| The model (the agent's answers) | Anthropic, to us | about $0.03 an answer at API prices at low effort; about $0.23 for an eight-question conversation before prompt caching (docs/milestones.md §3). Since 2026-11-09 the agent thinks at medium effort (`TORAN_AGENT_EFFORT`), about 1.5 to 2 times that (an estimate, see below) | Capped per store by its plan (`config.capUsd`, src/agent/spend.ts) and overall by `TORAN_MONTHLY_CAP_USD` |
| The model looking at photos | Anthropic, to us | a product's photo the agent looks at (view_product_images): about 550 input tokens on Shopify (asked for 640 pixels wide), up to about 1,600 elsewhere; six photos about $0.007 on Sonnet 5.5 the first time in a turn. A customer's photo: the same, up to four a message. The catalogue's looks (src/ingest/looks.ts): about 140 input and 25 output tokens a product on Shopify, read once a photo, so a 250-product store about $0.15 once | The looks pass skips a store past a cap; `TORAN_LOOKS=off` stops it |
| A store's WhatsApp number | Kapso, to us | Pro plan $25 a month with 3 numbers and 100,000 messages, then $10 a month a number (kapso.com/pricing) | Disconnected three days after a store stops (src/jobs/retention.ts) |
| WhatsApp messages Meta charges for | Meta, to the store | the store's own account (customer_managed billing): answers inside 24 hours of the customer's message are free; templates the store sends first (cart, review: Marketing; payment, shipping: Utility) at Meta's rates for Israel | Our contract says so (openfrequency-web, the Toran contract) |
| Instagram and Messenger | Zernio, to us | the first 2 accounts free, then $6 an account up to 10, $3 up to 100; the first 10,000 sent messages a month free, then $1 per 10,000; received messages free (zernio.com/pricing) | Shared with Teder's Zernio account |
| Email | Resend, to us | within its plan | Toran's own mail and the store's domain |
| Our own number (demo, support, alerts, pitches) | Meta, to us | Marketing and Utility templates at Meta's rates; the demo's answers are free inside 24 hours | One number for all of it |

**A typical store on the store plan**, 300 conversations of about four answers each: about 1,200 answers, roughly $36
of model at API prices before caching (less with it), plus its share of Kapso ($10, or less while under Pro's three
numbers), plus Zernio's $3 to $6 an account if Instagram and Messenger are connected. Well under the ₪590 a month,
and the setup fee covers the first day's reading and the two weeks of reading conversations with the owner.

**Sight and thought (2026-11-09).** The owner asked for it "even if ai costs double". The numbers above for medium
effort and for photos are estimates from the token rules (a photo is about width x height / 750 tokens; thinking is
billed as output), not measurements. Measure them from the `usage` rows: tag `agent` per answer before and after the
switch, tag `looks` per store. `TORAN_AGENT_EFFORT=low` puts the answers back where they were.

What is not known yet, and should be measured on the first real stores: the real number of answers per
conversation, the prompt cache's share in production, and Meta's template volume per store.
