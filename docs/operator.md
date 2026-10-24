# The operator's dashboard

The operator is the superadmin outside view-as. Their dashboard is Toran's home page: who to write to today about
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

## 4. Toran: the dashboard

These are operator-only sections on the home page. A customer's session sees today's page as before.

- **לפנות היום** (who to write to today) is one list across both products, most urgent first:
  - Toran stores that tried the demo and have not been talked to.
  - Next steps that are due, for anyone already in a conversation.
  - Reminders that are due, the ones whose page was opened first.
  - Teder demos that are ready to send (the person asked on the website).
  - Toran pages that are ready to send, the ones asked for on the website first, then by score.

  Each entry has its message (editable), a WhatsApp or email button that copies the message and opens the chat,
  and these buttons: שלחתי (sent), ענו לי (they replied), לא מעוניינים (not interested, with a reason), and
  מחר / בעוד שבוע (later). Pages that are ready but have no way to reach the store are listed apart, to find a
  contact for.
- **בשיחה** (in conversation): everyone who replied, with their next step and its date.
- **המשפך** (the funnel): each product's stages, the last 30 days and all time, and the rate from each stage to
  the next.
- **לקוחות וכסף** (customers and money): paying customers per product, the monthly revenue before VAT, payments
  that are late or still to come, and renewals in the next 7 days. Each line links to the workspace on
  accounts' `/admin`.
