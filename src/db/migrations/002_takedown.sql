-- "Take this page down": the owner of a store can ask, from the page's footer, for its
-- pitch page to be removed. The click is recorded (takedown_asked_at, and an event);
-- the page comes down when the request is confirmed in the dashboard (taken_down_at).
-- A taken-down page never shows again, its demo code stops working, and nothing more is
-- offered to send to that store: a takedown request is an opt-out.
ALTER TABLE stores ADD COLUMN takedown_asked_at timestamptz;
ALTER TABLE stores ADD COLUMN taken_down_at timestamptz;
