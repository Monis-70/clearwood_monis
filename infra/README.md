# Deploying the ClearWood backend

A runbook. Follow it top to bottom on a fresh Ubuntu server. It brings up the **backend API
only** — see [What is deliberately not configured](#what-is-deliberately-not-configured) at the
end.

---

## 0. Prerequisites

| Thing | Version | Why |
| --- | --- | --- |
| Ubuntu | 22.04 or 24.04 | what the commands below assume |
| Node.js | **20 or newer** (`engines.node` is `>=20`) | the app is built and run with it |
| MySQL | **8.0** | `utf8mb4_0900_*` collations, `SET PERSIST` |
| pm2 | latest | process manager |

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

```bash
cd /srv/clearwood/backend
npm run admin:reset-password
```

Follow the prompts: it takes the email of the account and a new password, and writes a fresh
argon2 hash.

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

---

## 7. Verify

```bash
curl -s http://127.0.0.1:7180/health
curl -s http://127.0.0.1:7180/ready
```

`/health` is a liveness probe and answers without touching the database.

`/ready` exercises the dependencies. A healthy response reports `status: "up"` overall and
`driver: "mysql"` for the database. If the database entry is down, the API is running but cannot
serve anything — check `DATABASE_URL` and that MySQL is listening on `127.0.0.1:3306`.

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

| Not configured | Status |
| --- | --- |
| Nginx, TLS, DNS | the domain is not available yet; the app is loopback-only until then |
| Razorpay | `PAYMENT_DRIVER=mock` — no real payment can be taken |
| SMTP | `MAIL_DRIVER=log` — mail is written to the log, not sent |
| SMS / OTP | `OTP_DRIVER=log` — the code is logged, not texted |
| Shiprocket | `SHIPPING_DRIVER=manual`, and the integration is **UNVERIFIED**; production refuses to boot on it without `SHIPPING_PROVIDER_VERIFIED=true` |
| Demo catalog | production is seeded **structural only**; the homepage has zero blocks by design |

`npm run preflight` reports every stub in use, so this table cannot quietly go stale.
