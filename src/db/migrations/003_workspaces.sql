-- The login moved to openfrequency-accounts (src/web/accounts.ts): a session belongs to one workspace there, and sees
-- only its workspace's stores here (src/web/workspace.ts). Everything else hangs off a store. NULL is no workspace: a
-- lead Toran found and is still selling to, which only the operator (the superadmin outside view-as) sees, until
-- npm run workspace:assign gives the store to the customer's workspace.
ALTER TABLE stores ADD COLUMN workspace_id integer;
CREATE INDEX stores_workspace ON stores (workspace_id);

-- Accounts owns who people are: the users table and its password hashes go.
DROP TABLE IF EXISTS users;
