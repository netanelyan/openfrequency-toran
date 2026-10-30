-- A worker loop's last sign of life (src/health.ts): /readyz says the worker is down when no loop has written here for
-- two minutes, whether it runs in the web's process (npm start) or beside it (npm run worker).
CREATE TABLE IF NOT EXISTS worker_beats (
  name      text PRIMARY KEY,               -- 'worker'
  at        timestamptz NOT NULL DEFAULT now(),
  pid       integer,
  revision  text                            -- the build that wrote it (REVISION, deploy/deploy.sh)
);
