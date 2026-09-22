# Database migration plan — SQLite (now) → MySQL 8 (later)

> **D7.** This document is the contract for going live. It is written now, while the schema is two
> tables, so that later prompts never introduce anything that would make the move painful.

Nothing in this repository requires MySQL today. The local stack is **Node 20 + npm only** —
no Docker, no database server, no cloud credentials.

---

## 1. Why the move is cheap

The rules below are enforced from Prompt 1 onwards (see `docs/PROJECT_CONTEXT.md` §5):

| Rule                                                                          | What it prevents                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **D1** provider comes from `DATABASE_PROVIDER`                                | hand-editing the schema at go-live                                                                             |
| **D2** no Prisma `enum` — `String` + TS const unions in `shared/src/enums.ts` | provider-specific `ENUM` DDL and a migration per new value                                                     |
| **D3** no `Json` scalar — `String` + `jsonColumn<T>()`                        | SQLite stores JSON as TEXT while MySQL has a real JSON type; the two behave differently in filters and indexes |
| **D4** no `@db.*` native attributes, no fulltext, no generated columns        | DDL that SQLite cannot express (and vice versa)                                                                |
| **D5** money is `Int` **paise**                                               | float drift and `DECIMAL` precision differences                                                                |
| **D6** `id` cuid + `createdAt` / `updatedAt` (+ `deletedAt` on user data)     | reliance on auto-increment ids, which do not survive an export/import cleanly                                  |

### How D1 actually works

Prisma rejects `provider = env("DATABASE_PROVIDER")`
(_"a datasource must not use the env() function in the provider argument"_), so the value is applied
by **one** script instead:

```
backend/scripts/sync-prisma-provider.cjs
```

It reads `DATABASE_PROVIDER` (process env first, then `backend/.env`), validates it against
`sqlite | mysql`, and rewrites the single `provider = "..."` line in `prisma/schema.prisma`.
It runs automatically before `postinstall`, `db:generate`, `db:migrate`, `db:deploy` and `db:reset`,
so **you never edit the schema by hand** — you change the env var.

---

## 2. The switch, step by step

### Step 0 — before you start

```powershell
npm test                     # everything green on sqlite
npm run build                # everything compiles
```

Take a copy of `backend/prisma/dev.db` (it is the only source of local data).

### Step 1 — export the current data

```powershell
npm run db:export --workspace backend      # added in Prompt 17; writes backup/<timestamp>/*.json
```

The exporter walks every model through Prisma (not raw SQL), so it is provider-independent and the
JSON it writes is already in the shape the importer expects. Because of D3 and D5 there is nothing
to transform: JSON columns are already strings and money is already an integer.

### Step 2 — point the app at MySQL

Edit `backend/.env` only:

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://clearwood:<password>@127.0.0.1:3380/clearwood"
```

Port **3380** is the reserved MySQL port (`docs/PROJECT_CONTEXT.md` §4).
Create the database with `utf8mb4` / `utf8mb4_unicode_ci`:

```sql
CREATE DATABASE clearwood CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### Step 3 — regenerate the migrations

SQLite migration SQL is not portable, so the migration history is rebuilt once for MySQL:

```powershell
cd backend
node scripts/sync-prisma-provider.cjs      # writes provider = "mysql" into schema.prisma
# archive the sqlite history, then start a MySQL one
git mv prisma/migrations prisma/migrations-sqlite-archive
npx prisma migrate dev --name init_mysql
```

`prisma migrate dev` now produces MySQL DDL from the _same_ `schema.prisma` — no model changes are
needed, which is the entire point of D2–D6.

> On the production host use `npx prisma migrate deploy` (never `migrate dev`).

### Step 4 — import the data

```powershell
npm run db:import --workspace backend -- --from backup/<timestamp>
```

The importer upserts by `id`, so it is idempotent and can be re-run after a failure.

### Step 5 — verify

```powershell
npm run db:seed          # idempotent; tops up any missing AppSetting rows
npm run build
npm start --workspace backend
```

Then check:

- `GET /ready` → `dependencies.database.driver` is **mysql** and `status` is **up**
- `GET /api/v1/version` → `drivers.db` is **mysql**
- `GET /api/v1/settings/public` → the same key/value map as before the move
- row counts per table match the export manifest

### Step 6 — roll back if needed

Set `DATABASE_PROVIDER=sqlite` and `DATABASE_URL="file:./dev.db"`, restore
`prisma/migrations-sqlite-archive`, run `npx prisma generate`. The application code is untouched, so
a rollback is a config change too.

---

## 3. The other three switches (same shape, same day)

| Concern  | Change                                                   | Extra work                                                                                                                                                                                             |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cache    | `CACHE_DRIVER=redis`, `REDIS_URL=redis://localhost:6380` | implement `backend/src/drivers/cache/redis.cache.ts` (documented TODO already in the file)                                                                                                             |
| Storage  | `STORAGE_DRIVER=s3` + `AWS_*` / `S3_*` keys              | implement `backend/src/drivers/storage/s3.storage.ts`, then copy `backend/storage/uploads/**` to the bucket preserving keys — `normaliseStorageKey()` guarantees the keys are identical across drivers |
| Mail     | `MAIL_DRIVER=smtp` + `SMTP_*` keys                       | implement `backend/src/drivers/mail/smtp.mail.ts`                                                                                                                                                      |
| Payments | `PAYMENT_DRIVER=razorpay` + `RAZORPAY_*` keys            | Shipped in Prompt 9A. Env validation refuses to start without the key id, secret and webhook secret, and without a second linked account when `SPLIT_ENABLED=true`                                     |

Env validation (`backend/src/config/env.ts`) enforces that each driver's keys are present **only when
that driver is selected**, so none of this blocks local development today.

---

## 4. Things that must never enter the schema

Later prompts will be tempted by these. Do not use them:

- `enum` blocks — use `String` + `shared/src/enums.ts`
- `Json` scalar — use `String` + `jsonColumn<T>()`
- `@db.Text`, `@db.VarChar(n)`, `@db.Decimal(p,s)` and friends
- `Decimal` / `Float` for money — integer paise only
- MySQL fulltext indexes or generated columns (search arrives in Prompt 7 built on portable columns)
- auto-increment integer primary keys

## 5. Testing note

The Vitest suite always runs against its own SQLite file (`backend/prisma/test.db`, rebuilt by
`backend/tests/global-setup.ts`). After switching to MySQL, point
`backend/vitest.config.mts` → `test.env.DATABASE_URL` at a disposable MySQL schema and keep
`migrate deploy` + `db seed` in the same global setup.
