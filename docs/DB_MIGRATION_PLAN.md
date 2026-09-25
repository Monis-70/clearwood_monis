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

| Concern  | Change                                                                  | Extra work                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cache    | `CACHE_DRIVER=redis`, `REDIS_URL=redis://:PASSWORD@127.0.0.1:6380/0`    | none - the Redis driver ships (Redis foundation prompt). It also moves rate-limit counters into Redis. Setup, failure behaviour and how to clear the cache safely: `infra/README.md` §2b               |
| Storage  | `STORAGE_DRIVER=s3` + `AWS_*` / `S3_*` keys                             | implement `backend/src/drivers/storage/s3.storage.ts`, then copy `backend/storage/uploads/**` to the bucket preserving keys — `normaliseStorageKey()` guarantees the keys are identical across drivers |
| Mail     | `MAIL_DRIVER=smtp` + `SMTP_*` keys                                      | implement `backend/src/drivers/mail/smtp.mail.ts`                                                                                                                                                      |
| Payments | `PAYMENT_DRIVER=razorpay` + `RAZORPAY_ENABLED=true` + `RAZORPAY_*` keys | Shipped in Prompt 9A, ON HOLD. Env validation refuses to start without `RAZORPAY_ENABLED=true`, the key id, secret and webhook secret, and without a second linked account when `SPLIT_ENABLED=true`   |

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

## 4a. `20260923090000_catalog_integrity` (Prompt 3)

Adds `Product.deletedSlug`, `ProductVariant.defaultMark` / `combinationKey`,
`ProductCategory.primaryMark` and `ProductMedia.primaryMark`, four unique indexes and three CHECK
constraints (PROJECT_CONTEXT §43). It remediates existing data **before** creating them, in one
forward-only file, so `prisma migrate deploy` succeeds on a database that already violates them:

1. deleted variants lose `isDefault`; per product the first default by `(position, id)` is kept;
2. the same for primary categories; extra PRIMARY images become `GALLERY`;
3. `combinationKey` is backfilled for live variants; if two share a combination, only the first
   by `(position, id)` gets the key (the others stay NULL and remain sellable);
4. soft-deleted products get `slug = 'deleted-{id}'`, the original kept in `deletedSlug`.

Before deploying, back up and review what step 3 will leave unkeyed:

```sql
SELECT productId, GROUP_CONCAT(id ORDER BY position, id) AS variants
FROM (
  SELECT v.productId, v.id, v.position,
    SHA2(GROUP_CONCAT(CONCAT(a.attributeId, '=', a.attributeValueId)
      ORDER BY a.attributeId COLLATE utf8mb4_bin SEPARATOR '&'), 256) AS k
  FROM ProductVariant v JOIN VariantAttributeValue a ON a.variantId = v.id
  WHERE v.deletedAt IS NULL GROUP BY v.id
) keyed
GROUP BY productId, k HAVING COUNT(*) > 1;
```

`tests/catalog-integrity-migration.test.ts` applies the migration to a scratch database seeded
with every violation and asserts the result; the key it computes in SQL matches
`combinationKeyOf()` in TypeScript.

## 4b. `20260924090000_product_listing_index` (Prompt 4)

Creates `ProductListingIndex` (one row per ACTIVE product: the DEFAULT customer group's price
range, `computedAt`; unique `productId`, FK with `ON DELETE CASCADE`) and backfills it from the
existing `SearchDocument` prices, so the storefront keeps its price order across the deploy.
Products without a document list at their base price until priced. After deploying, run one full
reindex (`POST /api/v1/admin/search/reindex?entityType=PRODUCT`), which rebuilds this index first
and then copies the prices into the search documents. Rollback is `DROP TABLE ProductListingIndex`
plus the previous build: nothing else references the table.

## 4c. `20260924120000_maintenance_task` and `20260924130000_product_listing_attribute` (Prompt 5)

- `MaintenanceTask`: one row per periodic job (lease owner and expiry, watermark, durable rebuild
  request, last run). No rows are seeded; the listing reconciler creates its own. Rollback:
  `DROP TABLE MaintenanceTask` with the previous build.
- `ProductListingAttribute`: one row per (product, attribute value) the listing filters and counts
  on, unique `(productId, attributeId, attributeValueId)`, index `(attributeValueId, productId)`,
  FKs to Product, Attribute and AttributeValue with `ON DELETE CASCADE`. Backfilled from specs
  plus active-variant options for every product that has a listing index row, so attribute filters
  and facets are unchanged across the deploy. Index names are explicit: MySQL caps identifiers at
  64 characters and the generated unique name was 67. Rollback: `DROP TABLE ProductListingAttribute`
  with the previous build (the listing read specs and variants directly).
- After deploying, nothing has to be run by hand: the first reconcile pass (within
  `LISTING_RECONCILE_INTERVAL_SECONDS`) re-prices whatever changed since the oldest index row.
  `npm run listing:reconcile --workspace backend` runs one pass on demand.

Engine version 2 (`PRICING_ENGINE_VERSION=2`) is a behaviour change, not a schema change: orders
keep their frozen breakdowns and the version they were priced with.

## 4d. `20260924150000_catalog_management` (catalog management phase)

Additive only; every new column means "not configured" when NULL, so no backfill runs.

- `Category.leadFormKey VARCHAR(64)` - the enquiry form a category offers (contract work).
- `AttributeValue.description VARCHAR(1000)` - option text shown in the PDP option matrix.
- `Product.featuredUntil DATETIME(3)` + index, `Product.badgeText VARCHAR(64)`,
  `Product.badgeColor VARCHAR(16)` - time-boxed featuring and an admin-written badge.
- `Collection.imageMediaId VARCHAR(64)` - the tile image (the banner stays the page header);
  tracked in `MediaUsage` as `COLLECTION_IMAGE`.
- `Enquiry` - project / quote requests (formKey, contact, context ids, `detailsJson` per D3,
  workflow status, assignee, admin note, `version`, soft delete). Plain id columns, no FKs: a
  deleted category or product must never delete a customer's request. Indexes: `(status,
createdAt)`, `(formKey, createdAt)`, `(categoryId)`, `(assignedToId, status)`.

Settings, not schema: `catalog.new_arrival_days` (30) and `catalog.badges` (JSON) are seeded as
AppSetting rows and edited through `PUT /api/v1/admin/catalog/settings`.

After deploying, nothing has to be run by hand. The seed is now create-only for categories,
attributes, collections and navigation items, so re-running it on a live database only adds the
new taxonomy groups (49 categories, 4 attributes) and never rewrites an admin's edits. Rollback:
the previous build ignores the new columns; `DROP TABLE Enquiry` and the five `DROP COLUMN`s undo
the schema.

## 4e. Catalog hardening (Prompt 6) - no migration

No schema change. `prisma validate`, `prisma migrate status` and a `migrate diff` of the migration
history against the schema on a shadow database agree. Deploy-relevant behaviour only:

- Relation types are codes in `ProductRelation.type` (VARCHAR 191); the new ones need no DDL.
- The seed is create-only for tax classes, customer groups, brands and synonyms too, and no longer
  re-adds a deleted navigation item. The first deploy of this build writes one private AppSetting,
  `seed.search_synonyms` (group `seed`); on a database seeded before it, existing synonyms are
  kept and only the marker is written.
- Known scale item, not needed at 1,000 products: the reconciler's `catalogWrittenSince` probe
  scans `updatedAt` on Product, ProductVariant, ProductCategory, ProductAttributeValue and
  Category without an index. At a much larger catalog, add `@@index([updatedAt])` to those five
  (a separate, additive migration).

## 4f. `20260925100000_import_job_checksum` (admin backend fixes)

Additive only: `ImportJob.fileChecksum CHAR(64) COLLATE utf8mb4_bin NULL`, the sha256 of the
file a dry run validated (registered in `caseSensitiveColumns.ts` like every other digest). `POST /admin/catalog/import/jobs/{id}/commit` refuses any other bytes with
409 `IMPORT_FILE_MISMATCH`. No backfill: a job created before the column has NULL and must be
validated again before it can be committed. Rollback: the previous build ignores the column;
`ALTER TABLE ImportJob DROP COLUMN fileChecksum` undoes it.

## 5. Testing note

The Vitest suite always runs against its own SQLite file (`backend/prisma/test.db`, rebuilt by
`backend/tests/global-setup.ts`). After switching to MySQL, point
`backend/vitest.config.mts` → `test.env.DATABASE_URL` at a disposable MySQL schema and keep
`migrate deploy` + `db seed` in the same global setup.
