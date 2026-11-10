# The "pro" look: design brief

The owner, 2026-11-09: "make both dashboard look more professional. research. shopify is a good example. save the
current style so i will be able to revert if i dont like the new".

Toran's desk and Teder's site have two looks each, picked by one setting (here `TORAN_STYLE`, in Teder `TEDER_STYLE`):

| look | what it is | files |
|---|---|---|
| `pro` (default) | solid and calm, after Shopify's admin | `src/web/static/style.css` + `src/web/static/style-pro.css` after it |
| `glass` | the frosted glass look the desk had until 2026-11-09 | `src/web/static/style.css` alone, untouched |

Both are served at the one address `/static/style.css` (`src/web/style.ts`), so no page changes with the look. The
glass file was not edited for this: `style-pro.css` only overrides it. A later change to `style.css` (a new card, a
new page) is therefore styled in both looks, and going back never loses a fix. The commit before the pro look is
tagged `style-glass-2026-11-09`.

## איך חוזרים לעיצוב הקודם

1. בשרת, בקובץ `/opt/toran/private/.env` מוסיפים שורה: `TORAN_STYLE=glass`
2. מפעילים מחדש את השירות: `systemctl restart toran`
3. מרעננים את הדף. העיצוב חוזר להיות הזכוכית, בדיוק כמו שהיה ב-9.11.2026.

כדי לחזור לעיצוב החדש, מוחקים את השורה (או כותבים `TORAN_STYLE=pro`) ומפעילים מחדש.

בתדר זה אותו דבר: `TEDER_STYLE=glass` בקובץ `/opt/open-frequency/private/.env`, ואז
`systemctl restart openfrequency`. כל אחד מהשניים חוזר לבד, אז אפשר להשאיר אחד בעיצוב החדש ואחד בישן.

(הנתיבים ושמות השירותים לקוחים מ-`deploy/toran.service` ומ-`deploy/openfrequency.service` של תדר.)

אם רוצים לראות את הקוד של העיצוב הישן כמו שהיה, הוא שמור ב-git בתגית `style-glass-2026-11-09`.

## What we took from the research

Sources: Shopify Polaris tokens as published (`@shopify/polaris-tokens` 9.4.2 and `@shopify/polaris` 13.9.5 CSS on
unpkg; polaris.shopify.com itself would not load for the fetcher), Shopify's "admin new look" posts (2024-2025),
Linear's "how we redesigned the Linear UI", and a breakdown of Stripe's dashboard. We took principles and scales, not
Shopify's brand: no logo, illustration, font or its green.

What makes those desks read as professional:

1. **Planes, not glass.** A grey page (Polaris uses `#f1f1f1`; ours is the `#eeeff2` every site already paints
   its browser bar with), white cards, a 1px border. Depth is a hairline (`0 1px 0`), and only what
   floats (a toast, a menu, the phone's action bar) gets a real shadow. Nothing is blurred.
2. **Colour means something.** The UI is greys. One accent per product for the main button, the chosen item and
   links; green, orange and red only for a status.
3. **One main action per screen.** One solid button; the rest are white with a border, plain text, or red when they
   destroy something.
4. **A 4px grid and few radii.** 4/8/12/16/20/24/32 for space; 8px for a control, 12px for a card; a pill only for a
   count.
5. **A tight type scale and two weights.** Title 24, card title 15-16, body 14, label 13, quiet 12. 400 and 700 only
   for anything that must stand out: Windows draws Hebrew 600 as 400 (measured on the owner's machine), so a heading
   at 600 looks like body text there.
6. **A side bar of rows.** 240px, a step darker than the page, 36px rows with 20px icons, the chosen row white with
   its icon in the accent. On a phone: a white bar on top, a tab bar at the foot, both flush with the screen.
7. **Quiet, aligned lists.** Small grey column heads, hairline dividers, numbers in tabular figures at the end,
   status as a small soft badge.
8. **Visible states.** Hover is one step of grey, the pressed button sinks, focus is a 2px ring in the accent.

## Tokens

Light:

| token | value | use |
|---|---|---|
| `--bg` | `#eeeff2` | the page, the colour of the browser bar (`theme.ts`, shared by every site) |
| `--nav-bg` / `--nav-on` | `#e6e7ea` / `#ffffff` | the side bar / its chosen row |
| `--surface` | `#ffffff` | a card |
| `--sub` | `#f7f7f7` | a row under the pointer, a fact inside a card |
| `--edge` | `#e3e3e3` | a card's border |
| `--line` / `--line-2` | `#ebebeb` / `#d4d4d4` | a divider / a control's border |
| `--field-edge` | `#8a8a8a` | a field's border (3:1 on white) |
| `--ink` / `--ink-2` / `--ink-3` | `#303030` / `#4a4a4a` / `#616161` | text: 12.6, 8.9, 6.2 to 1 on white |
| `--accent-fill` | Toran `#0f7a54`, Teder `#6a3fd6` | the main button (white on it 5.4 and 5.9 to 1) |
| `--accent` | Toran `#0b6a48`, Teder `#5a31c2` | the accent as text |
| `--ok` / `--warn` / `--bad` | `#19702f` / `#9a4200` / `#c70a24` | status, each with a soft `-bg` |
| `--r` / `--r-m` / `--r-s` | 12 / 8 / 6 px | card / control / badge |

Dark: page `#111113`, side bar `#19191b`, card `#1f1f1f`, borders `#313131`, ink `#ececec` / `#c7c7c7` / `#a3a3a3`,
the accent as text Toran `#4fcf9d`, Teder `#b9a4ff`. The light/dark switch is the same cookie as before.

Shadows: card `0 0 0 1px var(--edge), 0 1px 0 rgba(26,26,26,.07)`; secondary button `inset 0 0 0 1px rgba(0,0,0,.13),
inset 0 -1px 0 rgba(0,0,0,.13)` (Polaris's bevel); floating `0 8px 16px -4px rgba(26,26,26,.2)`.

## Components

- **Page header** (`.head`): the title 22px (24px on a desk), a 13px line under it, the main action at the end of
  the title's row.
- **Card** (`.panel`, `.card`, `.list`, `.kpi`): white, 12px, 20px padding (16px on a phone), 16px between cards.
- **Buttons** (`.btn`): 8px corners, weight 600, 44px tall on a phone (36px small), 36px on a desk (32px small), the
  height of a field beside them. `.primary` solid accent, plain `.btn` white with the bevel, `.ghost` plain text,
  `.danger` red text that turns solid red when armed.
- **Fields**: label above in 13px, a 1px border, 8px corners, a 2px accent ring on focus. 16px text on a phone so iOS
  never zooms in; 14px on a desk with a mouse.
- **Status** (`.chip.ok/.warn/.bad/.sig`): a small badge in the status's soft colour, 6px corners. Plain `.chip`
  stays a grey word.
- **Filters** (`.tabs`, `.seg`): rows of words, the chosen one on a grey fill (or white inside a segmented control).
- **Tables and lists**: 12px grey heads, 10px by 12px cells, hairline rows, a grey row under the pointer.
- **Icons**: 20px in the side bar, 22px in the tab bar, 18px (16px on a desk) in a button. Each icon is drawn centred
  in its 24-unit square, so beside a label it sits on the label's middle: the spark of "✦ לעוזר" was drawn 2 units
  high and is fixed in the sprite (`ui.ts`); measured in Chrome after the fix, every icon's centre is within 0.5px
  of its label's.

## Accessibility kept

Contrast AA for every text token on its surface, focus always visible, reduced motion and reduced transparency as in
`style.css`, Increase Contrast and the accessibility panel's high contrast (`html.a-contrast`) still win over the pro
tokens, and every phone target stays 44px.

## The two desks side by side

The owner, 2026-11-10: "Toran and teder dashboards should be consistent". Both desks follow these rules; a change to one
of them changes the other the same way, and both repos keep this section the same.

- **Who sees what.** Each product's own site shows the product, to everyone: a customer, and the operator too, who is in
  their own workspace there as its owner (accounts' `OF_OPERATOR_WORKSPACE`, accounts' docs/admin-split.md). The
  operator's pages (leads, demos, the review queue, every workspace, the server's settings, costs) are reached only from
  accounts' `/admin`, under `/admin/toran` and `/admin/teder`, where a line at the top of every page leads back to the
  admin dashboard. Nothing of the operator's is in a product's own nav, and no page there shows English internals,
  tokens, costs or a model's tool calls unless developer mode is on.
- **The nav.** Six sections, the same on a phone (the tab bar) and a desk (the side bar), in this order: היום, then the
  product's own work, then תוצאות, then הגדרות.

  | | 1 | 2 | 3 | 4 | 5 | 6 |
  |---|---|---|---|---|---|---|
  | Toran | היום | שיחות | מה הוא יודע | העוזר | תוצאות | הגדרות |
  | Teder | היום | פוסטים | מקורות | חשבון | תוצאות | הגדרות |

  Names are one or two plain words. A count of what waits is a red badge on its section. תוצאות has the same bars icon
  in both.
- **The header.** The mark and the product's name, then what the pages are about: Teder's account switcher, Toran's
  store (its colour, name and address, nothing to open). On a phone that pill sits beside the mark, which gives up its
  word for it; on a desk it is a row of its own under the mark, above the sections, with the side bar's toggle beside the
  mark.
- **The side bar's foot.** The month's meter across, a ring that fills and "N / of the plan": Toran's conversations
  (orange, then red, as the plan runs out), Teder's posts that went out ("פורסמו", never a warning: a full ring is the
  month kept); then signing out, then light or dark at its end. On a phone the same three sit in
  the top bar. The accessibility button sits inside the end of the tab bar on a phone, at the corner on a desk.
- **The page head.** `.head`: the title (22px, 24px on a desk), a 13px line under it, the main action at the end of the
  title's row. Today's line is the day.
- **Empty states.** `.empty`: an icon, one bold line that says what is not there yet, one plain line that says what will
  come or what to do, and at most one button.
- **Settings.** One column in the middle (760px), on a desk as on a phone; each part a panel, folded to a row on a phone
  (`details.mfold`); the account and signing out near the end; developer mode behind seven taps on the version line,
  for the operator only.
- **Folds and summaries.** On a phone a page's parts fold to rows with their names (`fold()`); a small "more" line is a
  `summary` in the accent colour with a chevron.
- **Buttons.** One solid `.primary` per screen for the main action; the rest plain, ghost or danger, as in Components
  above. A label says what happens, as a verb ("לשמור", "להמשיך"); Teder's older nouns ("שמירה") change to verbs as
  their pages are touched.
- **The app on a phone.** Each product's own site is the app a phone keeps: its manifest, its mark as the icon (Toran's
  three dots on green, Teder's wave on purple). Its pages under accounts' `/admin` offer no manifest, so a saved icon is
  never accounts' site under the product's name.
