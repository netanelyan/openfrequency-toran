# The lead autopilot

The owner, 2026-11-15: "i want the lead dashboard to be automatic. the dashboard chooses which stores should have a
demo (teder/toran/both). sends it itself, sells the products himself. AUTOMATIC", "20 leads a day, 10 at morning 10 at
afternoon", "even when a store is ready to buy, they should be able to do that themselves", "make the lead engine so
strong that it gets customers without me even looking at it".

Two halves:

- **The scheduled task** (a Claude Code routine on the owner's subscription, in Anthropic's cloud) is the operator: it
  reads the stores, looks at each one's site, chooses Toran, Teder, both or neither, asks the chosen ones the question,
  starts discovery when the pool runs low, and leaves the owner a note. It runs twice on working days (09:30 and 14:30
  Israel time) and once in the evening (19:00) to review. This file is its playbook.
- **Toran** (on the server, always on) does everything after a yes: thanks them, builds the chosen demo, sends it into
  the same chat once it is up (src/ops/ask.ts), and our support sells from there (agent/prompt.ts COMPANY_PROMPT, "A
  store we wrote to"). Nothing waits for a scheduled run once a store answered.

## Why the question

A first message that already offers the product is not the one approach the law allows a business (the Communications
Law's section 30A(ב), as the Supreme Court read it in רע"א 1954/14 חזני נ' הנגבי, 2014): only a neutral offer to agree
to receive offers is. So the first message asks only whether we may send the store an offer, says who writes and how to
stop (src/ops/outreach.ts OUTREACH_ASK, src/ops/emailPitch.ts by email), and nothing is built until they say yes. It has
no reminder: a second message to someone who did not answer is not allowed either. A yes is consent; from then on we
send what we built and talk with them.

## The door

`https://toran.openfrequency.co.il/autopilot/...`, JSON in and out (src/ops/autopilot.ts). The routines run in the
claude.ai environment "Lead autopilot", which reaches no host but toran.openfrequency.co.il, and whose network
secret adds `Authorization: Bearer <TORAN_AUTOPILOT_TOKEN>` to every request to it through its proxy: the run never
sees the key. Send no Authorization header, never look for a token, never print request headers. A 401 means the
secret is missing or wrong in the environment: stop, and say so in the run's answer.

| | |
|---|---|
| `GET /autopilot/state` | `on`, `quiet` (night, Shabbat, a holiday), `half` (morning/afternoon), `limits {day, batch}`, `asked {day, half}`, `pool {askable, undecided, daysLeft}`, `last24h {asked, yes, delivered, delivery_failed, undelivered}`, `spend {monthUsd, capUsd}`, `lastDiscovery` |
| `GET /autopilot/candidates?limit=40` | the stores it may ask, best score first: `id, name, domain, url, platform, score, scoreParts, about, facts {products, priceMin, priceMax, kinds, social {instagram, tiktok, facebook}}, reach (whatsapp/email), whatsappOnSite, toranCan, chosen, notes` |
| `GET /autopilot/site?id=` | the store's own pages as text, read by Toran: `home {url, status, title, text}`, `pages` (its shipping and about pages when it links them), `social`. The scheduled task reaches nothing on the internet but this door: read stores here, never with WebFetch |
| `POST /autopilot/decide {id, product, reason}` | product `toran`, `teder`, `both` or `none` (sets it aside); `reason` one short line in Hebrew, kept in the lead's notes |
| `POST /autopilot/ask {id}` | the question, on WhatsApp to its mobile or else by email. `{sent, why, said}` |
| `POST /autopilot/discover {source}` | `brave` (Hebrew searches by category) or `storecensus` (Israel's Shopify directory); new stores appear within minutes |
| `GET /autopilot/recent?hours=24` | every question and pitch: its channel, store, product, state, delivered/read, yes, deliver (pending/sent/failed/expired), replied, auto answer, error, chat link |
| `POST /autopilot/note {text, tell}` / `GET /autopilot/notes` | a note for the owner, in Hebrew; `tell: true` also sends it to the owner's WhatsApp (the evening review only) |

`ask` refuses with a reason, never throws: `quiet`, `day_cap`, `batch_cap`, `off` mean stop this run;
`template_pending` means Meta is still reviewing the question on WhatsApp, so ask only the stores whose `reach` is
`email` this run; `quality` means
Meta lowered our number's rating, so stop and say so in the note; `already`, `not_candidate`, `stopped`, `bounced`,
`no_email`, `bad_email`, `closed` mean skip that store; `failed` is Meta or the mail provider refusing, so skip it and,
after three, stop and note it.

## A morning or afternoon run

1. `GET /autopilot/state`. Off: note "הטייס כבוי" once a day and stop. Quiet: stop.
2. Pool: if `pool.daysLeft < 3` and no discovery started today (`lastDiscovery.at`), `POST /autopilot/discover`
   `{"source":"brave"}` and `{"source":"storecensus"}`.
3. Room this run: `min(limits.batch - asked.half, limits.day - asked.day)`. None: go to step 6.
4. `GET /autopilot/candidates?limit=40`. For each, best first, until the room is used:
   - **Look at the store.** `GET /autopilot/site?id=<id>`, with its candidate facts (products, prices, kinds, its
     Instagram, TikTok and Facebook). Read it the way a careful salesperson would. Is it a real, active Israeli online
     store, with Hebrew pages, prices in shekels, shipping in Israel and products in stock? A site that did not load
     (`home.status` 0 or 400 and up) is not asked this run.
   - **Set it aside (`none`)** with the reason when it is any of these:
     - a shop selling a famous brand it is not (a "DIOR Israel" on a domain that is not the brand's: counterfeit)
     - a big chain, a marketplace or a brand's local branch
     - dropshipping: 7 to 15 days or more from abroad, generic imported items, a tracking page of a shipping app
     - inactive: nothing in stock, years-old dates, a "coming soon" page
     - not a store at all
     - a category WhatsApp does not serve (alcohol, tobacco and vaping, weapons, adult products, medicines, supplements
       with health claims, gambling)
   - **Choose the product:**
     - `toran`, Toran answering their customers, when `toranCan` is true and customers clearly ask them things: a
       WhatsApp button or chat on the site (`whatsappOnSite`), sizes, variants, delivery and returns questions, 20
       products or more, or prices high enough that people ask before buying.
     - `teder`, slideshows for TikTok, Instagram and Facebook, when they sell something visual or giftable (fashion,
       jewelry, beauty, home, kids, food, crafts) and have, or should have, an Instagram or TikTok presence.
     - `both` when both fit and `toranCan` is true.
     - When unsure between one and both, choose the one that fits best: a single clear offer is answered more often.
   - `POST /autopilot/decide {id, product, reason}`. Then, if not `none`, `POST /autopilot/ask {id}`, and read its `why`
     as above.
   - Never ask a store you set aside, and never more than the room.
5. Do not message anyone in any other way. The question is the only first message the law allows, and the door sends
   it; everything after a yes is Toran's.
6. `POST /autopilot/note` with a short note in Hebrew for the owner, in plain words, no English and no codes: how
   many were asked (by WhatsApp and by email), how many set aside and the usual reasons, discovery started or not, and
   anything that needs them (Meta's rating, a send that failed, the pool running dry).

## The evening run (review)

No questions. `GET /autopilot/recent?hours=24` and `GET /autopilot/state`, then one note in Hebrew, posted with
`{"text": "...", "tell": true}` so it reaches the owner's WhatsApp (keep it under 900 characters):

- the day's numbers: asked, said yes, demos delivered, deliveries that failed, answers, asked to be removed
- each store that said yes or answered, by name, and where it stands (its chat link when there is one)
- what went wrong and what Toran did about it (a demo that failed to build, a WhatsApp that did not arrive and went by
  email)
- one line on what to change, only when the numbers say so (for example, many stores set aside for the same reason
  means discovery should look elsewhere)

## Rules

- Never print, store or repeat the token. Never put a phone number or an email address in a note; a store's name is
  enough.
- Never send anything but through the door, and never contact a store, a person or a service on your own.
- Do not change code, open pull requests or push. The checkout is for reading this file.
- The owner reads the notes on their phone: Hebrew, short, plain, no em dashes, no exclamation marks.
