# Which model answers, and how hard it thinks (2026-11-11)

The owner, 2026-11-11: "also make sure toran and teder ai are smart. even if a slideshow gets to 0.5$, and even if
toran costs 1.5x themselves." Production answered on Sonnet 5.5 at medium effort (`TORAN_MODEL_AGENT=claude-sonnet-5-5`,
`TORAN_AGENT_EFFORT` unset). This page is how the next setting was chosen: twelve shoppers' conversations, the same ones
on each candidate, measured on the Claude Code subscription (nothing paid), and read one by one.

**The choice: Sonnet 5.5 at high effort** (`src/agent/llm/index.ts`, `AGENT_EFFORT`). About 1.1 to 1.2 times today's
cost an answer, 7.9 seconds of model time an answer against 6.8 today, and it nearly stopped handing questions to the
owner without looking them up (1 of 44 against 4 of 55). Nothing to set on the server: production's
`TORAN_MODEL_AGENT=claude-sonnet-5-5` stays, and `TORAN_AGENT_EFFORT` unset now means high. `TORAN_AGENT_EFFORT=medium`
puts it back.

## How it was measured

`node scripts/eval-models.ts` builds the fictional store (kli-cheres.example: 14 products with their variants and
stock, the shipping, returns, contact and FAQ pages) through the real pipeline in a database in memory, and runs each
conversation through the real loop (the prompt, the tools, the guard) on the claude-cli backend, once per
configuration, two at a time. A warm-up message comes first on each configuration and is not counted, so every counted
answer reads the store's prompt from the cache, as a store that answered in the last hour does. Four runs on
2026-11-11 and 12, not every configuration in each.

What is recorded for each answer: the reply as the customer got it and as the model wrote it, the tools called, the
handoff, what the guard cut, the cost at API prices, the model's own time (the CLI's `duration_api_ms`, without the
seconds the CLI takes to start on this machine, which production never pays) and the thinking tokens.

Three things about the numbers:

- **The cost is what production would be billed for the same tokens.** Until this change, a call on the CLI recorded
  only its last request: with thinking and a JSON answer the CLI answers in two (the model thinks and answers, then the
  JSON is written), so the thinking was left out, about 200 tokens of every answer at high effort, about 450 at xhigh.
  The CLI's tokens are now counted as production would pay for them (`usageOf` in src/agent/llm/cli.ts): one pass
  over the conversation, and the answer with all its thinking. The cost column is that, from runs 2 to 4 (the first
  run kept no CLI totals), with the conversation's new part priced as written to the 5-minute cache, as the API backend
  writes it.
- **One store, small.** A real store's searches return more products and its policies are longer, so its answers cost
  more than these. The comparison between configurations holds; the dollars are this store's.
- **The CLI cannot show photos**, so no question depends on one.

## The conversations

| | What the shopper wrote | A right answer |
| --- | --- | --- |
| q1, product fit | מחפשת מתנה לחברה שמכורה לקפה, משהו עד 100 ₪. מה יש? | the two mugs in stock under 100 ₪ (espresso 59 ₪, the sand mug 89 ₪), and one short question |
| q2, size and colour | כמה נכנס בספל החול? ויש אותו בתכלת? | 350 ml; light blue is sold out, sand and grey are in |
| q3, stock | האגרטל הגבוה חזר למלאי? | still sold out, no date made up |
| q4, care | ספל האספרסו אפשר לשים במדיח? | matte glaze: better by hand (the description and the FAQ) |
| q5, shipping | כמה עולה משלוח לחיפה ותוך כמה זמן זה מגיע? | 35 ₪, free over 300 ₪, 3 to 5 business days |
| q6, returns | קניתי סט צלחות ערב והגוון לא מתאים לי בבית. אפשר להחזיר? | within 14 days, whole and unused, return shipping on the customer |
| q7, an order, no key | מה קורה עם ההזמנה שלי? מספר 1042 | it cannot be checked here: handed to the store, no status made up |
| q8, a complaint | הקערה שהזמנתי הגיעה שבורה. ממש מבאס, חיכיתי לה שבוע | one human line and a handoff; the store's rule (a photo within 48 hours) may be asked for |
| q9, vague then precise | יש לכם משהו יפה לבית? then משהו לפרחים, קטן, עד 100 ₪ | a short question or a few options; then the small ball vase, 95 ₪ |
| q10, English | Hi, do you ship to London? And how much is the big olive bowl? | in English: no shipping abroad for now; the bowl is 165 ₪ |
| q11, must hand off | אני מארגנת אירוע ל-30 איש. אפשר הנחה על 30 ספלים? | a discount is the store's: handoff |
| q12, several conditions | צריכה משהו לנרות שבת בגוון בהיר, התקציב שלי 120 ₪ | the double candle holder in sand, 119 ₪, in stock |

## What it found

| Configuration | Answers (runs) | $ an answer | x today | Model time an answer (90th percentile) | Longest call | Thinking tokens an answer | Calls an answer | Right | Handed off without looking |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sonnet 5.5, medium (today) | 65 (4) | $0.0100 | 1.00 | 6.8 s (9.2 s) | 5.6 s | 66 | 2.4 | 57 of 65 | 4 of 55 |
| **Sonnet 5.5, high (the choice)** | 52 (4) | $0.0114 | 1.13 | 7.9 s (10.7 s) | 7.3 s | 216 | 2.3 | 48 of 52 | 1 of 44 |
| Sonnet 5.5, xhigh | 39 (3) | $0.0150 | 1.50 | 8.9 s (11.1 s) | 8.8 s | 467 | 2.4 | 36 of 39 | 0 of 33 |
| Opus 5.5, low | 26 (2) | $0.0203 | 2.03 | 9.9 s (16.7 s) | 18.8 s | 29 | 2.5 | 24 of 26 | 0 of 22 |
| Opus 5.5, medium | 13 (1) | about $0.025 | about 2.5 | 12.7 s (18.7 s) | 15.4 s | 139 | 2.4 | 12 of 13 | 0 of 11 |

In the run that had all four on the same day (run 4): medium $0.0099, high $0.0118 (1.19), xhigh $0.0147 (1.48), Opus
at low $0.0203 (2.05). Opus at medium ran once, before the CLI totals were kept: its cost is the recorded one with its
thinking added. "Handed off without looking" counts a question handed to the owner with no search, no product, no
policy and no order looked at (q8 and q11 go to the owner by the rules, so they are not counted). "Right" is the reply
the customer got holding the facts of the right answer above. Every miss of high, xhigh and Opus is q5, and all but
one of them the guard's (below).

**Medium (today) skips the lookup.** In 4 of 55 answers it handed the question to the owner without looking: "ספל
האספרסו אפשר לשים במדיח?" got "על זה אני לא בטוח, אז העברתי את השאלה לנציג מהחנות" while the product page and the
FAQ say it; the English question twice, the bowl's price included; and the candles under 120 ₪, where its handoff said
the search did not work and it never searched. Once more on the dishwasher it searched and still handed off. Not every
time: each of these was answered right in another run.

**High looks first.** One such answer in 44 (the shipping question, once), and otherwise the same facts as Opus. It
thinks about three times as much as medium (216 thinking tokens an answer against 66), which is most of what it costs
more.

**xhigh and Opus add a little more.** Told of a broken bowl, Opus asked for the order number and a photo every time
(the store's own rule asks for one within 48 hours), xhigh 2 times in 3, high once in 4, medium never; asked for a
discount, they handed it off and offered the two mugs meanwhile now and then (high and medium did not). xhigh costs 1.5
times today's answer, the owner's limit itself on a small store, and Opus 2 to 2.5 times with up to twice the wait:
neither is the default. xhigh is one setting away (`TORAN_AGENT_EFFORT=xhigh`) once production's own numbers (the
`usage` rows tagged `agent`) show the room.

**The wait.** At high the longest call took 7.3 seconds and no call wrote 700 tokens; a call may take 40 seconds
(`MODEL_TIMEOUT_MS`), a turn 60 (`TURN_DEADLINE_MS`), and 8,000 output tokens (`AGENT_MAX_TOKENS`). The answers took
1.1 seconds more than at medium, 10.7 seconds at the 90th percentile against 9.2.

## What made Toran look less smart, and was not the model

Found on the way, the same on every configuration, and fixed on 2026-11-12. "After" is 13 more runs of q5, q10 and
q11 at high effort, on the subscription ($0.0113 an answer for the three, $0.0107 before); "before" is the four runs
above. The four runs' 195 answers were also put through the new guard as the model wrote them, with every tool call
run again: q5's 12 cut answers pass, q11's 12 doubled replies say the line once, and no other reply changes.

- **The guard cut a right shipping answer.** On q5 the model gave the price in 14 of 15 answers, as "משלוח עד הבית
  בכל הארץ, כולל חיפה, עולה 35 ₪" or "גם לחיפה"; the claim check (src/agent/claims.ts, an `area` claim) found no
  "חיפה" in the shipping page, which says "בכל הארץ", cut the sentence and handed off. In 12 of them the customer read
  "על זה אני לא בטוח, אז העברתי את השאלה לנציג מהחנות. הוא יחזור אליך כאן. ההזמנה מגיעה תוך 3 עד 5 ימי עסקים..."
  **Now** a city or a region inside Israel is backed by a wider place the store ships to (`WITHIN`: Haifa by the north
  or by all of Israel, Tel Aviv by the centre), unless the page excepts it or a place between; remote places and
  kibbutzim pass only when the store names them, as before (Eilat, the Arava, the Golan and Judea and Samaria are part
  of all of Israel since 2026-11-12, docs/decisions.md). After: the
  price and the delivery time in 10 of 13 answers, none cut. The other 3 are the model's own: it handed off on its
  first call, before it looked anything up (once in 4 before, at high), which no change here touches.
- **A doubled line on a discount.** On q11 the guard cut the model's own "הנחה מאשר רק נציג מהחנות, אז העברתי לו את
  הבקשה." in all 15 answers (the `promise` rule), put its own line in, and kept the model's next sentence, so in 12 of
  them the customer read "...הוא יחזור אליך כאן. הוא יחזור אליכם כאן." (or "אליך" twice). **Now** a reply says the
  hand-off once (src/agent/guard.ts): a sentence of the model's that only says it was passed on or who answers goes,
  and a second honest line says only what it is not sure of. After: the line once in 13 of 13.
- **English questions about the store's pages found nothing.** On q10, 13 of 15 answers called `get_policy` in
  English; the passages are Hebrew, the embeddings' distance cut (0.19, src/agent/tools.ts) let none through, and the
  answer was a handoff. "shipping to London, international shipping" and "do you ship abroad" returned "No passage";
  "משלוח לחו"ל" returned "כרגע אין משלוחים לחו"ל". **Now** `get_policy` reads what the question is about in the claim
  check's vocabulary, Hebrew and English alike, and measures a Hebrew passage from those concepts said in Hebrew too
  ("משלוח חוץ לארץ", 0.15 from the shipping page); a Hebrew question gets what it got before. Before: 0 of 15 said
  there is no shipping abroad. After: 11 of 13, all in English. Of the other 2, one handed off before looking, and in
  one the CLI's written tool call put its arguments one level too deep (`{"input": {"topic": ...}}`), so `get_policy`
  got no topic: the claude-cli backend's own way of calling tools (src/agent/llm/cli.ts), 1 of 405 calls in all the
  runs, which the API's tool calls do not have.
- **An English product name found nothing either** (found in the runs after). Once, the model searched the products
  only for "big olive bowl"; the names are Hebrew, and the result's rule said to tell the customer the store does not
  seem to carry it, so the shopper read "I also didn't find a big olive bowl in the store". **Now** words in one
  language that find nothing in a catalogue named in the other ask for one more search in the names' language first
  (`search_products`). The bowl's 165 ₪ after: 11 of 13, the misses being that answer and one that handed off before
  looking. In the 3 runs since this change, the one answer that searched in English first was asked to search again,
  and found the bowl in Hebrew.

## The other calls

| Call | Model | Effort | Why |
| --- | --- | --- | --- |
| The customer's answer (agent/loop.ts) | Sonnet 5.5 | high (was medium) | above |
| The owner's assistant (assistant/index.ts) | Sonnet 5.5 | medium (was low), 4,000 tokens out (was 1,200) | it answers the owner about their own store over several tool calls; a few questions a store a week |
| The store's voice, read from its copy (agent/voice.ts) | Sonnet 5.5 | medium (was low), 4,000 tokens out (was 1,200) | one call a store each time its copy changes, and every answer's tone follows it |
| A receipt's check (channels/payCheck.ts) | Sonnet 5.5 | low | it reads one screenshot into fields, and code compares them |
| The photos' looks (ingest/looks.ts) | Sonnet 5.5 | low | eight photos a call over a whole catalogue: a colour and a look |
| The guard's second opinion (agent/claims.ts, off) | Sonnet 5.5 | low | a yes or a no on one sentence |

Reading the store, its knowledge and FAQ, and the pitch pages are code, not a model. Every call's model is
`TORAN_MODEL_AGENT` (the looks' `TORAN_MODEL_LOOKS` first); its default in code is now Sonnet 5.5, as production has
it, where it was Opus 5.5.

## What it means for a month

At about $0.0114 an answer, a store on the 590 ₪ plan with 300 conversations of about four answers costs about $14 of
model a month (about 43 ₪, 7% of what it pays), far under the 30% alert (177 ₪, $55.84) and the 50% stop (295 ₪,
$93.06) of src/agent/spend.ts (docs/costs.md). On the 1,190 ₪ plan, 1,500 conversations come to about $68 (217 ₪,
18%). A real store's answers cost more than these (above), so the big plan, busy, is the one the alert is for.

## Running it again

```
node scripts/eval-models.ts --configs claude-sonnet-5-5:medium,claude-sonnet-5-5:high
```

On the subscription, about seven minutes a configuration on the dev laptop. Every answer goes to
`private/eval/models-<date>.json` (or `--out`); the table at the end is per configuration. Read the answers: the
numbers say what it cost and how long it took, not whether it was right. `--only q5,q10,q11` runs some of the
conversations. Point `TORAN_MODELS_DIR` at a folder that has the embedding model (a checkout's `private/models`), or
the script downloads it into its throwaway folder first, and if that fails `get_policy` matches words only, which
production does not.
