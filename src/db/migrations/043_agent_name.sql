-- The name the store's owner gave its bot ("מה תורן יודע", pages/customer.ts), said when it opens a conversation
-- (agent/intro.ts). NULL: it has none, and it opens as the store's bot. Our own support is "תורן" in code.
ALTER TABLE stores ADD COLUMN agent_name text;
-- When the bot last said who it is in this conversation. NULL: it has not yet, or a person answered since
-- (channels/owner.ts ownerReply), and its next answer opens with the line.
ALTER TABLE conversations ADD COLUMN introduced_at timestamptz;
