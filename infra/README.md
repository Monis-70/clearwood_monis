# Deploying the ClearWood backend

A runbook. Follow it top to bottom on a fresh Ubuntu server. It brings up the **backend API
only** — see [What is deliberately not configured](#what-is-deliberately-not-configured) at the
end.

---

## 0. Prerequisites

| Thing   | Version                                    | Why                                                                     |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Ubuntu  | 22.04 or 24.04                             | what the commands below assume                                          |
| Node.js | **20 or newer** (`engines.node` is `>=20`) | the app is built and run with it                                        |
| MySQL   | **8.0**                                    | `utf8mb4_0900_*` collations, `SET PERSIST`                              |
| Redis   | **7.x**                                    | shared cache and rate limits for the four PM2 workers ([2b](#2b-redis)) |
| pm2     | latest                                     | process manager                                                         |

`sharp` and `argon2` are **native modules**. They compile against the platform they are installed
on.

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config libvips-dev
```

> **Never copy `node_modules` from a development machine.** A Windows or macOS build of `sharp` or
> `argon2` will not load on Linux, and the failure is an opaque loader error at boot. `node_modules`
> is gitignored; always run `npm ci` on the server.

---

## 1. Clone, install, build

```bash
sudo mkdir -p /srv/clearwood /var/log/clearwood
sudo chown "$USER" /srv/clearwood /var/log/clearwood

git clone <your-remote> /srv/clearwood
cd /srv/clearwood

npm ci
npm run build
```

`npm run build` compiles `shared`, then `backend`, then both frontends.

---

## 2. Create `backend/.env`

Start from the example, which lists every key the application reads:

```bash
cp backend/.env.example backend/.env
```

Then edit it. The groups in that file mark each key `[BOOT]`, `[DRIVER]` or `[TUNE]`.

### The database URL

```
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://clearwood_app:PASSWORD@127.0.0.1:3306/clearwood_prod?connection_limit=8&pool_timeout=20"
```

**`127.0.0.1:3306` — MySQL on this server.** Not port 3307. Port 3307 is the SSH tunnel a laptop
uses for administration; the application must never use it. A product page issues 79 queries, and
at the tunnel's 67 ms round trip that is a five-second page.

`connection_limit=8` is tied to the worker count — see `infra/ecosystem.config.cjs`, which shows
the arithmetic.

### The secrets

Generate each one straight into the file. Do not type them, do not reuse them, do not let one
appear in your shell history:

```bash
cd /srv/clearwood/backend

for KEY in JWT_ACCESS_SECRET JWT_REFRESH_SECRET ADMIN_JWT_ACCESS_SECRET \
           ADMIN_JWT_REFRESH_SECRET CART_COOKIE_SECRET MEDIA_SIGNING_SECRET; do
  VALUE=$(openssl rand -base64 48 | tr -d '\n')
  sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" .env
done

chmod 600 .env
```

Set `NODE_ENV=production` and a real `SITEMAP_BASE_URL`, `WEB_ORIGIN`, `ADMIN_ORIGIN` and
`CORS_ORIGINS`.

Leave `TRUST_PROXY=false` while the app is reached directly on loopback. When nginx is put in front
of it on this machine, set `TRUST_PROXY=loopback` - otherwise every shopper shares nginx's IP and
therefore one rate-limit bucket. Never `true`: the app refuses to boot with it, because it lets any
client choose its own IP.

---

## 2b. Redis

PM2 runs four workers. With `CACHE_DRIVER=memory` each keeps its own cache and its own rate-limit
counters: an admin edit reaches the other three only when their entries expire, and every limit is
effectively four times looser. Production runs `CACHE_DRIVER=redis`.

```bash
sudo apt-get install -y redis-server
```

In `/etc/redis/redis.conf` (6380 is the port this project reserves for Redis):

```
bind 127.0.0.1 -::1
port 6380
requirepass <openssl rand -base64 36>
maxmemory 256mb
maxmemory-policy allkeys-lru
save ""
appendonly no
```

It is a cache, so it is not persisted: a restart costs a cold cache and fresh rate-limit windows,
nothing else. Every key the app writes has a TTL. Then `sudo systemctl restart redis-server` and, in
`backend/.env`:

```
CACHE_DRIVER=redis
REDIS_URL=redis://:THE-REDIS-PASSWORD@127.0.0.1:6380/0
REDIS_KEY_PREFIX=cw:
```

The URL is never logged. Give each environment sharing one Redis its own `REDIS_KEY_PREFIX`.

**When Redis is down the API keeps serving.** Reads fall back to MySQL, rate limits count per worker
until it returns, and `/ready` answers `200` with `status: "degraded"` so the workers stay in
rotation. An invalidation that could not reach Redis is retried when it returns; until then the
affected keys are treated as misses rather than served stale.

To clear the cache, delete this app's keys only - never `FLUSHALL` or `FLUSHDB`:

```bash
export REDISCLI_AUTH='THE-REDIS-PASSWORD'   # keeps the password off the process list
redis-cli -p 6380 --scan --pattern 'cw:*' | xargs -r -n 500 redis-cli -p 6380 unlink
```

---

## 3. The admin credential — read this, do not skip it

**An admin row already exists in `clearwood_prod`:**

```
email:    admin@clearwood.local
password: the placeholder from .env.example, which is public in this repository's history
```

**Setting `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` does NOT change it.** The seed *upserts* and
deliberately preserves admin edits, so re-running it leaves the existing row exactly as it is.
That behaviour is correct — it is what stops a re-seed trampling production — and it means the
existing credential has to be corrected explicitly.

### Correct it

Put the NEW password in `backend/.env` as `ADMIN_SEED_PASSWORD` (production refuses to start while
it is still the placeholder), then reset the existing row by its email:

```bash
cd /srv/clearwood/backend
npm run admin:reset-password -- --email admin@clearwood.local
```

The script is non-interactive. It writes a fresh argon2 hash of `ADMIN_SEED_PASSWORD` to that one
account, sets `mustChangePassword` (every admin route except the self-service ones answers
`403 PASSWORD_CHANGE_REQUIRED` until the password is changed in the UI), bumps its permission
version and revokes every session. Without `--email` it targets `ADMIN_SEED_EMAIL`. It prints the
email only, never the password, and exits non-zero if no such account exists.

Production also refuses to sign in with the published placeholder password, so the old credential
is unusable from the moment this build is deployed - the reset is what makes the account usable
again. That row was created by an earlier seed as SUPER_ADMIN and keeps that role; the seed now
creates an ordinary ADMIN on a fresh install and never touches an existing account.

Change the email too, so the public placeholder address is not an account that exists. From the
admin UI once you are in, or directly:

```bash
mysql -u clearwood_app -p clearwood_prod \
  -e "UPDATE AdminUser SET email = 'you@yourdomain.com' WHERE email = 'admin@clearwood.local';"
```

### Verify the old password no longer works

```bash
# EXPECT: HTTP 401, and an error code of INVALID_CREDENTIALS
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:7180/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@clearwood.local","password":"ChangeMe@12345"}'

# EXPECT: HTTP 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:7180/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@yourdomain.com","password":"THE-NEW-PASSWORD"}'
```

A `401` on the first and a `200` on the second is the proof. Anything else means the reset did not
take — stop and fix it before exposing the server.

> After five consecutive failures an account locks, which is the progressive lockout working. Wait
> it out rather than assuming the reset failed.

---

## 4. Gate: `npm run check:production`

```bash
cd /srv/clearwood
npm run check:production
```

- **`OK - every production secret has a real value`** → proceed.
- A list of key names → those keys still hold their `.env.example` placeholder, or are too short.
  Fix every one. The application **will refuse to boot** otherwise; the same check runs at startup.

It prints key names only, never values.

---

## 5. Gate: `npm run preflight`

```bash
npm run preflight
```

One pass/fail line per check: Node version, every key present, no placeholder secrets, the database
reachable, the schema present, every migration applied, and the 45 case-sensitive columns still
collated `utf8mb4_bin`. It also reports which drivers are **stubs**.

Every failure is named at once. Fix them all, then re-run.

---

## 6. Start under pm2

```bash
cd /srv/clearwood
pm2 start infra/ecosystem.config.cjs
pm2 save
pm2 startup          # prints a command — run the command it prints, with sudo
```

`pm2 save` records the current process list; `pm2 startup` installs the systemd unit that restores
it after a reboot. Doing only one of the two is the usual reason a server comes back empty.

```bash
pm2 status
pm2 logs clearwood-api --lines 50
```

### Scheduled work: the listing reconciler

Price rules open and close on their own schedule, with no write to react to, so something has to
look at the clock (docs/PROJECT_CONTEXT.md §45). By default every worker offers to run the listing
reconciler every `LISTING_RECONCILE_INTERVAL_SECONDS` (60); a MySQL lease (`MaintenanceTask`) lets
exactly one of the four do the work, so nothing extra has to be configured.

To keep that work out of the web workers instead, set `LISTING_RECONCILE_INTERVAL_SECONDS=0` and
schedule the one-shot command - it takes the same lease, so an overlap with a slow run is harmless:

```bash
# crontab -e (as the deploy user)
* * * * * cd /srv/clearwood/backend && npm run listing:reconcile >> /var/log/clearwood/reconcile.log 2>&1
```

---

## 7. Verify

```bash
curl -s http://127.0.0.1:7180/health
curl -s http://127.0.0.1:7180/ready
```

`/health` is a liveness probe and answers without touching the database.

`/ready` exercises the dependencies. A healthy response reports `status: "ready"`, the database
`up` with `driver: "mysql"`, and the cache `up` with `driver: "redis"`. `status: "degraded"` (still
HTTP 200) means Redis is down and reads are coming from MySQL - check `REDIS_URL` and
`systemctl status redis-server`. HTTP 503 means the database is down: the API is running but cannot
serve anything - check `DATABASE_URL` and that MySQL is listening on `127.0.0.1:3306`.

From your laptop, confirm the API is **not** reachable from outside:

```bash
curl -s --max-time 5 http://<server-ip>:7180/health   # EXPECT: no answer
```

An answer here means the app bound to `0.0.0.0`. Stop it and fix the bind address before going
further — there is no TLS and no proxy in front of it yet.

---

## 8. Database administration from a laptop

Schema changes and seeding run **through an SSH tunnel**, never from the application:

```bash
ssh -L 3307:127.0.0.1:3306 user@<server> -N
```

Then, on the laptop, with `DATABASE_URL` pointed at `127.0.0.1:3307/clearwood_prod` **for that one
command only**:

```bash
DATABASE_URL="mysql://clearwood_app:PASSWORD@127.0.0.1:3307/clearwood_prod" \
  npx prisma migrate deploy
```

Measured: a schema deploy over the tunnel takes ~128 s, a structural seed ~270 s. Both are
round-trip bound. **Prefer running them on the server**, where the same work is near-instant.

`prisma migrate dev` does **not** work against production: `clearwood_app` cannot create the shadow
database Prisma needs. Use `migrate deploy`.

The test suite refuses to run against anything but `127.0.0.1:3306` or `localhost:3306`, and
refuses the database named `clearwood_prod` outright — it creates and drops databases.

---

## What is deliberately not configured

| Not configured  | Status                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nginx, TLS, DNS | the domain is not available yet; the app is loopback-only until then                                                                                                                                                          |
| Razorpay        | ON HOLD. `PAYMENT_DRIVER=mock`; the live driver also needs `RAZORPAY_ENABLED=true`. In production the mock refuses every signature and checkout offers cash on delivery only                                                  |
| SMTP            | `MAIL_DRIVER=log` — mail is not sent; in production only the recipient (masked), subject and size are logged, never the body                                                                                                  |
| SMS / OTP       | `OTP_DRIVER=log` — the code is logged in development only; in production it is neither texted nor logged                                                                                                                      |
| Shiprocket      | ON HOLD and **UNVERIFIED**. `SHIPPING_DRIVER=manual`; Shiprocket is used only with `SHIPROCKET_ENABLED=true`, its credentials and `SHIPPING_PROVIDER_VERIFIED=true`, otherwise it falls back to manual with a startup warning |
| Demo catalog    | production is seeded **structural only**; the homepage has zero blocks by design                                                                                                                                              |

`npm run preflight` reports every stub in use, so this table cannot quietly go stale.
