// pm2: the toran job. The dashboard, the pitch pages, the webhook and the worker, in one process on 127.0.0.1:4710.
//
//   cd /opt/openfrequency-toran && npm ci --omit=dev && npm run init-private
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
//
// Node 24 or later (package.json engines): it runs the TypeScript as it is. Keys, DATABASE_URL among them, go in
// $TORAN_HOME/.env (./private/.env), mode 600; a value set here wins over the file. Nothing secret goes here.

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'toran',
      script: 'scripts/web.ts',
      args: '--worker',
      // pm2 runs a .ts file with ts-node unless told otherwise.
      interpreter: 'node',
      cwd: path.resolve(__dirname, '..'),
      // One process: the worker takes jobs in the same process as the web.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // The embedding model (about 120 MB on disk) is loaded into memory with onnxruntime; 1G leaves it room.
      max_memory_restart: '1G',
      // Time for the worker to finish the job in hand and the database to close (scripts/web.ts, on SIGINT).
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TORAN_ENV: 'prod',
        // Only Caddy, the website's lead service and accounts on this machine reach it. Caddy's X-Forwarded headers
        // are trusted because it connects from 127.0.0.1 (src/web/auth.ts), so TORAN_TRUST_PROXY stays unset.
        TORAN_LISTEN: '127.0.0.1',
        PORT: '4710',
      },
    },
  ],
};
