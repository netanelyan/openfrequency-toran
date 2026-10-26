# App Review: Messenger and Instagram

What to hand Meta so the app "Toran by OpenFrequency" (1676534190705066) can answer the Pages and Instagram accounts
of stores that are not ours. WhatsApp went in on 2026-10-25. Meta keeps one submission open per app, so this one goes in
once WhatsApp's is decided. Submitting is the owner's, never Claude's (connecting-channels.md, step 4).

Until then, everything below works for anyone with a role on the app, which is enough to record the videos.

## What is set up already

- **Messenger.** The use case is added. Webhook fields `messages`, `messaging_postbacks` and `message_echoes` are
  subscribed, with the redirect `https://toran.openfrequency.co.il/meta/oauth/messenger`. The Facebook Login for Business
  configuration **Toran Messenger** (`1132581012852683`, user access token, the three Page permissions) is in
  `META_FB_CONFIG_ID`.
- **Instagram.** The use case is added (Instagram app ID `2002641267419767`). The webhook field `messages` is
  subscribed, with the business login redirect `https://toran.openfrequency.co.il/meta/oauth/instagram`.
- **Toran.** `TORAN_CHANNELS` has both channels. Our company store (95, `openfrequency.co.il`) connects its own Page
  and Instagram from `/admin`: the operator gets the button there for that store only (pages/social.ts).

## Before recording

1. **The accounts.**
   - Our Facebook Page.
   - Our Instagram professional account, with "Allow access to messages" on (Instagram settings, Messages and story
     replies, Message controls, Connected tools).
   - A second, personal Facebook and Instagram account to write from, as a customer would.
2. **Connect them.**
   - Messenger: `https://accounts.openfrequency.co.il/admin/toran/lead/95/messenger`, "לחבר את הדף בפייסבוק". Log in
     with the account that manages our Page. If it manages more than one Page, pick ours.
   - Instagram: `https://accounts.openfrequency.co.il/admin/toran/lead/95/instagram`, "לחבר את האינסטגרם". Log in with
     our Instagram account.
3. **Try one message on each** from the personal account, and see Toran answer. Then delete those conversations, so
   the video starts clean.
4. **The screen.** Meta's reviewers read English, and Toran is in Hebrew. Either record with English captions added
   afterwards, or keep the notes below (with their timestamps) next to each video. Show the browser's address bar
   throughout.

## Video 1: Messenger (pages_show_list, pages_manage_metadata, pages_messaging)

Name the file `messenger - connect and reply.mp4`. About 90 seconds.

1. Toran's dashboard, store 95's Messenger page. Press "לחבר את הדף בפייסבוק".
2. Facebook's login. The window lists the permissions. Approve. *(pages_show_list, pages_manage_metadata)*
3. If the account manages more than one Page, Toran lists them. Pick OpenFrequency. *(pages_show_list)*
4. Back in Toran: "מחובר". The Page is now subscribed to the app's webhook. *(pages_manage_metadata)*
5. On a phone or a second window, signed in as the personal account: open Messenger, write to the Page, for example
   "Hi, what does Toran cost?".
6. Toran answers within seconds. Show the answer in Messenger. *(pages_messaging)*
7. Back in Toran's inbox: the conversation, with the customer's message and Toran's reply.
8. Answer once yourself from the Page's inbox in Meta Business Suite. Show that it appears in Toran's inbox too, and
   that Toran steps back in that conversation. *(pages_messaging, message echoes)*

## Video 2: Instagram (instagram_business_basic, instagram_business_manage_messages)

Name the file `instagram - connect and reply.mp4`. About 90 seconds.

1. Toran's dashboard, store 95's Instagram page. Press "לחבר את האינסטגרם".
2. Instagram's login with our professional account. The window lists the permissions. Approve.
3. Back in Toran: "מחובר" with our @username. *(instagram_business_basic)*
4. From the personal Instagram account, send our account a direct message.
5. Toran answers. Show the answer in Instagram. *(instagram_business_manage_messages)*
6. Toran's inbox: the conversation.
7. Answer once yourself from the Instagram app. Show it in Toran's inbox, and Toran stepping back.

## What to paste for each permission

Each request asks how the app uses the permission, and for the video. Paste these, and fix the timestamps to the
final videos.

**pages_show_list**
> Toran is a customer-service assistant for small online stores. A store owner connects their Facebook Page so Toran can
> answer customers who message the Page. After Facebook Login, Toran reads the list of Pages the owner manages, so the
> owner can choose the store's Page when they manage more than one. Toran reads only each Page's id, name, access
> token and the owner's tasks on it (to list only Pages they can answer messages on), keeps only the chosen Page, and
> shows the others to no one. Video 1, 0:05 to 0:30.

**pages_manage_metadata**
> Once the store owner picks their Page, Toran subscribes that Page to the app's webhook (POST /{page-id}/subscribed_apps
> with messages, messaging_postbacks and message_echoes), so the customers' messages reach Toran. When the owner
> disconnects, Toran removes the subscription. Toran changes nothing else on the Page. Video 1, 0:30 to 0:40.

**pages_messaging**
> Toran answers the store's customers in Messenger on the store's behalf: product questions, prices, shipping and
> returns, from the store's own website. It answers only people who wrote to the Page, inside the 24-hour standard
> messaging window. It never starts a conversation and sends no promotional messages. When the owner answers from the
> Page's inbox, Toran receives that answer as an echo and stops answering in that conversation for 12 hours. Every
> conversation is in the owner's Toran inbox. Video 1, 0:40 to 1:30.

**instagram_business_basic**
> After Instagram Login, Toran reads the professional account's id and username, so it knows which account the
> webhook's messages are for and can show the owner which account is connected. It reads no media and no followers.
> Video 2, 0:05 to 0:30.

**instagram_business_manage_messages**
> Toran answers the store's customers in Instagram Direct on the store's behalf, from the store's own website: product
> questions, prices, shipping and returns. It answers only people who wrote to the account, inside the 24-hour window,
> and never starts a conversation. The owner's own replies from the Instagram app arrive as echoes, appear in Toran's
> inbox, and stop Toran in that conversation. Video 2, 0:30 to 1:30.

**Human Agent (optional, worth asking for in the same submission)**
> When a customer's question needs the store owner (an order problem, a refund, a complaint), Toran hands the
> conversation to the owner. Owners are small businesses and often answer the next day, past the 24 hours. With the
> HUMAN_AGENT tag, the owner's own reply from Toran's inbox reaches the customer up to 7 days after their last
> message. The tag is used only on replies a person wrote, never on Toran's automatic answers.

Once Human Agent is approved, set `META_HUMAN_AGENT=1` on the server (connecting-channels.md, "Past 24 hours").

## Notes for the reviewer

Paste this in the submission's notes:

> Toran by OpenFrequency is a B2B tool for small online stores. The store owner signs in to Toran's dashboard
> (accounts.openfrequency.co.il), connects their Page or Instagram professional account with Facebook Login for
> Business or Instagram Login, and Toran answers their customers' messages. The dashboard is in Hebrew, for Israeli
> stores; the videos have English captions (or: each step is described above with its timestamp). Privacy policy:
> https://openfrequency.co.il/privacy, which also says how to ask for data to be deleted. Disconnecting a Page or
> account in Toran removes its token and the webhook subscription at once.

If Meta asks for a login to try it themselves, make a reviewer account in accounts with a workspace that has a test
store, and give them that. Making it, and its password, is the owner's.

## After approval

1. Connect a first customer's Page or Instagram from their own dashboard (`/lead/<id>/messenger`, `/lead/<id>/instagram`).
2. Delete the WhatsApp test template `toran_test_message`, if WhatsApp's review is done too.
