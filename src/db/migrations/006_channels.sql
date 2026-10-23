-- Channels past the WhatsApp demo number (src/channels/): a store's own email address now, Messenger and Instagram
-- next. One customer on two channels is two conversations; nothing here tries to tell they are the same person.

-- A store's own account on a channel: the address its mail is forwarded to, its Facebook Page, its Instagram account.
-- The demo number is not one of these: it is every store's, and wa_users routes it.
CREATE TABLE channel_accounts (
  id            serial PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel       text NOT NULL,                   -- email | messenger | instagram
  kind          text NOT NULL,                   -- the adapter: resend | sim | meta
  external_id   text NOT NULL,                   -- the address mail comes to, the page id, the Instagram account id
  name          text,
  secret        text,                            -- an access token, encrypted (Meta); NULL for email
  status        text NOT NULL DEFAULT 'active',  -- active | off
  meta          jsonb NOT NULL DEFAULT '{}',
  connected_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX channel_accounts_store ON channel_accounts (store_id);

-- The account a conversation came in on (NULL: the demo number), what the channel keeps about the thread (email: the
-- subject and every Message-ID in it, so a reply finds its conversation), and the owner's hold on it: while
-- agent_paused_until is ahead, the agent does not answer here.
ALTER TABLE conversations ADD COLUMN account_id integer REFERENCES channel_accounts(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN agent_paused_until timestamptz;
CREATE INDEX conversations_account ON conversations (account_id, peer) WHERE account_id IS NOT NULL;

-- Each message knows its channel (copied from its conversation when an insert leaves it out). role gains 'owner': the
-- store's owner answering from the inbox, with author saying who. automated says why a customer message was not
-- answered (an auto-reply, a bounce, a mailing list); delivery holds the provider's id for each part sent.
ALTER TABLE messages ADD COLUMN channel text;
UPDATE messages m SET channel = c.channel FROM conversations c WHERE c.id = m.conversation_id;
CREATE FUNCTION messages_channel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel IS NULL THEN
    SELECT channel INTO NEW.channel FROM conversations WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_channel BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_channel();
ALTER TABLE messages ALTER COLUMN channel SET NOT NULL;
ALTER TABLE messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN author text;
ALTER TABLE messages ADD COLUMN automated text;
ALTER TABLE messages ADD COLUMN delivery jsonb;

-- Addresses mail never goes to again: they bounced, or their owner marked a reply as spam.
CREATE TABLE mail_suppressed (
  address  text PRIMARY KEY,
  reason   text NOT NULL,                        -- bounced | complained
  at       timestamptz NOT NULL DEFAULT now()
);
