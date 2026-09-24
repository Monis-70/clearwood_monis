/**
 * PM2 process definition for the ClearWood backend.
 *
 * Start with:  pm2 start infra/ecosystem.config.cjs
 * Then:        pm2 save && pm2 startup    (see infra/README.md)
 *
 * ---------------------------------------------------------------------------------------------
 * WHY FOUR WORKERS, AND WHY connection_limit=8. Change one and you must redo this arithmetic.
 *
 * MySQL on the VPS is configured with max_connections = 151.
 *
 *   4 workers x 8 pooled connections            = 32
 *   + 1 admin/tunnel session for a human         =  1
 *   + 1 spare for `prisma migrate deploy`        =  1
 *   + 1 spare for a seed run                     =  1
 *                                                 ---
 *                                                  35   of 151  (23%)
 *
 * The headroom is deliberate and large. A connection pool is not a throughput dial: Prisma opens
 * connections lazily and a pool that is never exhausted costs nothing, whereas a pool that IS
 * exhausted fails requests that had nothing wrong with them. The budget also has to survive a
 * mistake - somebody leaving a tunnel open, a seed running while traffic is served - without the
 * site going down, and 116 connections of slack is what buys that.
 *
 * If the worker count goes up, connection_limit must come down. The product is what matters:
 * keep `workers x connection_limit` under about 40 until somebody has measured a reason not to.
 *
 * `connection_limit` is set in DATABASE_URL, not here - Prisma reads it from the URL:
 *   mysql://user:pass@127.0.0.1:3306/clearwood_prod?connection_limit=8&pool_timeout=20
 * ---------------------------------------------------------------------------------------------
 *
 * BIND ADDRESS. Until a reverse proxy exists, the app must answer on 127.0.0.1 ONLY. It has no
 * TLS, no rate limiting in front of it and no DNS name; exposing 0.0.0.0 would put an
 * unauthenticated admin API on the public internet. Nginx and TLS are a later prompt.
 *
 * CACHE. Four workers need CACHE_DRIVER=redis in backend/.env: with the memory driver each worker
 * keeps its own cache and rate-limit counters (the app logs a warning at boot). infra/README.md §2b.
 */

module.exports = {
  apps: [
    {
      name: 'clearwood-api',
      cwd: '/srv/clearwood',
      script: 'backend/dist/server.js',

      exec_mode: 'cluster',
      instances: 4,

      env: {
        NODE_ENV: 'production',
        // Loopback only. See the note above before changing this.
        HOST: '127.0.0.1',
        API_PORT: 7180,
      },

      autorestart: true,
      /*
       * Caps V8's old-generation heap only. Without it V8 collects lazily and, under load, workers
       * reached 520-620 MB RSS with ~75 MB of live heap, past the 512M limit below, so PM2 would
       * recycle healthy workers. RSS still
       * includes what this flag does not bound: the Prisma query engine, buffers, code and the
       * young generation (measured 350-420 MB RSS with it, same throughput - PROJECT_CONTEXT §46).
       */
      node_args: ['--max-old-space-size=384'],
      // A worker that has grown past this is leaking; recycling it beats degrading the site.
      max_memory_restart: '512M',
      // Stop a crash loop from filling the disk with restarts in seconds.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 10000,

      merge_logs: true,
      time: true,
      out_file: '/var/log/clearwood/api-out.log',
      error_file: '/var/log/clearwood/api-error.log',

      // Never in production: a file watcher on a deployed tree restarts on log rotation.
      watch: false,
    },
  ],
};
