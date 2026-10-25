# The operator's dashboard

The operator is the superadmin outside view-as. Their dashboard is on accounts' `/admin` (section 4): who to write to today about
Toran or Teder, with what message; who is already in a conversation; the funnel of each product; and the customers
and the money. The leads live in Toran, which finds stores, builds their pitch pages, tracks the opens and keeps
the outreach. Teder's store demos and the accounts customers are read from those services, which are on the same
machine, at each page load. Teder's demos are copied into Toran every few minutes, so that Toran can also keep
their outreach.

```
   Toran (the dashboard) ── GET /internal/ops/customers ──▶ accounts  (workspaces, subscriptions, invoices)
                         ── GET /internal/demos ──────────▶ Teder     (the store demos and their opens)
   openfrequency.co.il   ── POST /internal/lead {url, code} ▶ Toran   (a Toran demo request, by its REQ- code)
```

All three routes are local-only. They take `Authorization: Bearer <OF_INTERNAL_TOKEN>` (the same value in every
service's `.env`, 32 characters or more), and they refuse a request that has `X-Forwarded-For`, or that comes from
a socket that is not loopback. Every answer is JSON with `Cache-Control: no-store`.

## 1. Accounts: `GET /internal/ops/customers`

This route is on accounts' internal listener (127.0.0.1:4741), beside `/internal/session` and under the same
checks. It answers every customer workspace (the operator's own has none), newest first:

```json
{
  "today": "2026-10-24",
  "workspaces": [
    {
      "id": 3, "slug": "dana-shop", "name": "Dana Shop", "disabled": false, "createdAt": "2026-10-01T09:00:00.000Z",
      "products": ["teder", "toran"],
      "people": 2, "invitesWaiting": 1, "lastLoginAt": "2026-10-23T18:00:00.000Z",
      "subscriptions": [
        { "product": "toran", "monthly": 449, "vat": "excluded", "setup": 990, "startedOn": "2026-10-01",
          "paidUntil": "2026-10-31", "endsOn": null, "state": "paid", "nextChargeOn": "2026-11-01" }
      ],
      "invoices": { "count": 2, "lastIssuedOn": "2026-10-01" }
    }
  ]
}
```

`state` is one of these:
- `paid`: the paid period covers today.
- `waiting`: started, nothing paid yet.
- `late`: the paid period ended, and the subscription has not.
- `ending`: paid, and `endsOn` is set.
- `ended`.

The states are the same as the home page's (`describe()` in `src/accounts/subscriptions.js`). `monthly` and
`setup` are ₪ before VAT when `vat` is `excluded`.

## 2. Teder: `GET /internal/demos`

This route is on Teder's site (127.0.0.1:4700), beside `POST /internal/lead` and under its checks. It answers every
store demo, newest first, at most 500:

```json
{
  "demos": [
    {
      "id": 12, "domain": "dana-shop.example", "url": "https://dana-shop.example/", "name": "Dana Shop",
      "status": "approved", "whatsapp": "972500000123",
      "pageUrl": "https://teder.openfrequency.co.il/s/dana-shop-x1y2",
      "createdAt": "...", "readyAt": "...", "approvedAt": "...", "removedAt": null, "error": null,
      "opens": 3, "visitors": 1, "lastOpenAt": "..."
    }
  ]
}
```

- `pageUrl` is the page's absolute public address while the page is public (approved, and not removed), and null
  otherwise.
- `opens` counts the page's views by anyone who is not signed in to OpenFrequency.
- `visitors` counts the distinct browsers among them, by a cookie, the way Toran counts its pitch pages.

## 3. The website: a Toran demo request by its code

Since 2026-10-23, Toran counts a demo asked for on openfrequency.co.il only when the person writes to the demo
number with the request's code (`src/channels/request.ts`). The website's part:

1. The Toran demo form takes the store's address only. The WhatsApp number proves itself by writing.
2. `server/lead.mjs` makes a code `REQ-XXXXXX` (6 of `A-Z0-9`, random), keeps it with the lead, and hands Toran
   `{ "url", "code" }` at `/internal/lead`, retrying as before.
3. It answers the form with the code and a `https://wa.me/<TORAN_DEMO_WA>?text=...` link whose message holds the
   code. The form's success state shows that button.
4. Toran does the rest: one demo per number, and the reply on WhatsApp.

## 4. Where the dashboard lives: accounts' /admin

The operator's dashboard is on accounts' `/admin`, the superadmin's console, behind its password and authenticator
code. toran.openfrequency.co.il shows Toran only. Toran keeps the work behind the dashboard:
- the list of who to write to, and the outreach on each lead
- the copies of Teder's demos
- sending a demo asked for on the website by itself

It gives all of that to `/admin` through two internal routes, under the same checks as `/internal/lead` (OF_INTERNAL_TOKEN,
loopback, no `X-Forwarded-For`). Accounts reaches Toran at `OF_TORAN_INTERNAL` (default `http://127.0.0.1:4710`).

### `GET /internal/ops`

```json
{
  "teder": { "ok": true },
  "items": [
    { "key": "toran:12", "product": "toran", "id": "12", "reason": "tried_demo", "rank": 100, "name": "...",
      "domain": "...", "why": "ניסו את הדמו", "message": "...", "target": { "kind": "whatsapp", "href": "https://wa.me/...",
      "label": "להעתיק ולפתוח וואטסאפ" }, "direct": false, "mark": "reminded", "page": "https://...", "at": "...",
      "leadUrl": "https://toran.openfrequency.co.il/lead/12" }
  ],
  "noContact": [{ "id": 31, "name": "...", "domain": "...", "score": 71, "leadUrl": "..." }],
  "stuck": [{ "domain": "...", "phone": "9725...", "at": "...", "why": "...", "storeId": 7, "leadUrl": "..." }],
  "conversations": [{ "key": "teder:7", "product": "teder", "id": "7", "name": "...", "domain": "...", "replied_at": "...",
    "next_step": "...", "next_step_at": "...", "target": { ... }, "page": "...", "status": "...", "leadUrl": null }],
  "funnels": { "toran": [{ "key": "found", "label": "נמצאו", "all": 12, "month": 3 }], "teder": [ ... ] }
}
```

- `items` is already in its order (src/ops/queue.ts says why).
- `reason` is one of reconnect, tried_demo, next_step, asked_toran, asked_teder, reminder, teder_reminder, first_send.
  `reconnect` (rank 110, first) is a store that has Toran whose WhatsApp has to be connected again: its Meta token
  ends within 10 days or has ended (docs/connecting-channels.md, step 2). Its message asks them to, with the link, and
  its `page` is the store's WhatsApp page. Its `mark` is sent: on such a store, "שלחתי" records that they were told,
  and the card comes back after three days while the number still waits.
- `mark` says what "שלחתי" records: sent, reminded, or next (a next step: no message; its card offers the next-step
  form).
- `direct` means the message can go out now from the demo number (the `direct` action).
- `leadUrl` is the lead's page on Toran's dashboard, and null for a Teder lead.
- The funnels' last stage, `customers`, comes with `all` and `month` as null: accounts fills it from its
  subscriptions.

### `POST /internal/ops/<toran|teder>/<id>/<action>`

The body is JSON `{ "by": "<the operator, for the audit>", "text": "...", "days": 1, "reason": "price" }`, with only
what the action takes.

| action | does |
|---|---|
| sent | the first message went out |
| reminded | the one reminder (or the question after a demo) went out |
| direct | Toran only: sends the demo link on the demo number now, then records sent |
| replied | they answered |
| next | `text` and `days`: the next step |
| later | `days` 1 or 7 |
| lost | `reason`: not_interested, price, has_solution, no_answer, not_fit or other |
| reopen | undoes lost and later |
| pilot, paid | Toran only |
| won | Teder only |

It answers `200 { "ok": true, "message": "<Hebrew line for the operator>" }`, or `400 { "ok": false, "error":
"<Hebrew line>" }` for an action the rules refuse (a second reminder, a link past its 24 hours).
