-- The customer's own choice to stop the store's order updates (payment and shipping) from the page of message settings
-- (/u/<token>, web/unsubscribe.ts), apart from the reminders (the cart and the review): the owner, 2026-11-06,
-- docs/todo.md, "the customer can turn them off". The consent itself is a row of auto_consent with scope 'orders'
-- (auto/consent.ts); this is when the link's address stopped them, for the page to show, as stopped_at is for the
-- reminders. Numbered 060 so it never meets a migration made on another branch at the same number.
ALTER TABLE auto_links ADD COLUMN orders_stopped_at timestamptz;
