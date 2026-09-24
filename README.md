# ClearWood Furnitures

Premium Indian furniture e-commerce. **100% in-house manufacturing, zero outsourcing, every product
manufactured individually** — with made-to-order "Make your own &lt;X&gt;" customization.

Three surfaces, one monorepo: a public **storefront**, a separate **admin panel**, and the **REST API**
they both consume.

> **Status: Prompt 1 of 17 — Foundation & config.**
> No catalog, products, payments or business UI yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Prerequisites

**Node 20+ and npm. That is the entire list.**

No Docker, no MySQL, no Redis, no S3 bucket, no Razorpay account, no domain. Every external
dependency sits behind a driver interface selected by an env var, so going live later is a
configuration change, never a code change.

| Concern  | Now         | Later          | Selected by         |
| -------- | ----------- | -------------- | ------------------- |
| Database | SQLite file | MySQL 8        | `DATABASE_PROVIDER` |
| Cache    | in-memory   | Redis          | `CACHE_DRIVER`      |
| Storage  | local disk  | S3             | `STORAGE_DRIVER`    |
| Mail     | console log | SMTP           | `MAIL_DRIVER`       |
| Payments | mock        | Razorpay Route | `PAYMENT_DRIVER`    |

---

## Install and run

```powershell
npm install          # also creates backend/.env and generates the Prisma client
npm run db:migrate   # applies the init_foundation migration to backend/prisma/dev.db
npm run db:seed      # idempotent: seeds the public AppSetting rows
npm run dev          # API + storefront + admin, all three at once
```

> `npm install` copies `backend/.env.example` to `backend/.env` if it does not exist.
> Copy `frontend/web/.env.example` and `frontend/admin/.env.example` to `.env` too if you want to
> override the defaults — both apps fall back to `http://localhost:7180/api/v1`.

## Ports (reserved — never change)

| Service              | URL                   |
| -------------------- | --------------------- |
| Backend API          | http://localhost:7180 |
| Storefront           | http://localhost:7181 |
| Admin panel          | http://localhost:7182 |
| _(reserved)_ Adminer | 7183                  |
| _(reserved)_ MySQL   | 3380                  |
| _(reserved)_ Redis   | 6380                  |

## Endpoints so far

| Endpoint                                                                                               | Purpose                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                          | liveness — touches no dependency                                                                |
| `GET /ready`                                                                                           | readiness — `SELECT 1` + cache ping; 503 only when the DB is down (cache down = 200 `degraded`) |
| `GET /api/v1/version`                                                                                  | app name, version, env and the **active driver** for each dependency                            |
| `GET /api/v1/settings/public`                                                                          | flat key/value map of every public `AppSetting` (optional `?group=`)                            |
| `GET /api/v1/catalog/categories/tree`                                                                  | the whole category tree, nested (`?depth=`, `?includeInactive=`)                                |
| `GET /api/v1/catalog/categories/:slug`                                                                 | one category with breadcrumbs, children and **inherited** attributes                            |
| `GET /api/v1/catalog/attributes`                                                                       | attribute dictionary, paginated (`?categorySlug=`, `?filterableOnly=`)                          |
| `GET /api/v1/navigation/:key`                                                                          | a whole menu — `MAIN`, `FOOTER_PRIMARY`, `FOOTER_SECONDARY`, `MOBILE`, `TOP_BAR`                |     | `POST /api/v1/admin/auth/login` | admin realm sign-in — sets `cw_adm_*` cookies |
| `… /admin/auth/{refresh,logout,logout-all,me,change-password,forgot-password,reset-password,sessions}` | admin session management                                                                        |
| `… /admin/{users,roles,permissions,audit-logs}`                                                        | permission-gated RBAC administration                                                            |
| `GET /api/v1/admin/catalog/categories`                                                                 | guard-chain proof — reuses the Prompt 2 category service                                        |
| `POST /api/v1/auth/{register,login,otp/request,otp/verify}`                                            | storefront sign-up and sign-in (password or OTP)                                                |
| `… /auth/{refresh,logout,me,change-password,forgot-password,reset-password,email/*}`                   | storefront session management                                                                   |     | `GET /docs`                     | branded Swagger UI                            |
| `POST /api/v1/admin/media/upload`                                                                      | multipart upload — validates, stores, generates renditions, dedupes                             |
| `… /admin/media/{config,gc,bulk-delete,:id,:id/replace,:id/reprocess,:id/restore,:id/permanent}`       | the media library (permission-gated by `media.asset.*`)                                         |
| `… /admin/media-folders`                                                                               | the media folder tree; system folders are protected                                             |
| `… /admin/products/:productId/media`                                                                   | attach / update / reorder / detach product imagery                                              |
| `GET /api/v1/catalog/products/:slug/gallery`                                                           | public, resolved gallery (`?variantId=`, `?attributeValueId=`, `?device=`)                      |
| `GET /media-signed/*`                                                                                  | HMAC-verified private asset delivery (the local stand-in for a presigned GET)                   |
| `… /admin/catalog/categories{,/tree,/:id,/:id/move,/reorder,/:id/delete-impact}`                       | category CRUD, tree moves and delete-impact previews                                            |
| `… /admin/catalog/{attribute-groups,attributes,attribute-values}`                                      | the attribute dictionary, with in-use guards                                                    |
| `… /admin/catalog/{brands,tax-classes,collections,price-adjustments}`                                  | supporting catalog entities (tax classes sit on `pricing.tax.*`)                                |
| `… /admin/catalog/products{,/:id,/:id/duplicate,/:id/publish,/:id/publish-blockers}`                   | product CRUD, duplication and the publish gate                                                  |
| `… /admin/catalog/products/:id/variants{,/matrix/preview,/matrix/generate}`                            | variant CRUD and the variant matrix                                                             |
| `… /admin/catalog/variants/:id/inventory{,/adjust}`                                                    | ledger-backed stock history and adjustments                                                     |
| `… /admin/catalog/{bulk,import/:entity,import/jobs,export/:entity}`                                    | bulk actions and CSV import/export                                                              |
| `GET /openapi.json`                                                                                    | generated OpenAPI 3.0 document                                                                  |

---

## How to verify Prompt 1

Run these in order from the repo root. Every command must succeed.

### 1. Types, lint and tests

```powershell
npm run typecheck    # 4 workspaces, zero errors
npm run lint         # eslint ., zero problems
npm test             # 17 shared tests + 14 backend tests, all passing
npm run build        # shared -> backend -> web -> admin, all green
```

Expected tail of `npm test`:

```
 ✓ tests/money.test.ts (17 tests)
 Test Files  1 passed (1)
 ✓ tests/health.test.ts (3 tests)
 ✓ tests/api.test.ts (5 tests)
 ✓ tests/errors.test.ts (6 tests)
 Test Files  3 passed (3)
```

### 2. The API

Start it with `npm run dev` (or `npm run dev:backend`), then:

```powershell
curl http://localhost:7180/health
curl http://localhost:7180/ready
curl http://localhost:7180/api/v1/version
curl http://localhost:7180/api/v1/settings/public
```

Expected output:

```jsonc
// GET /health
{"success":true,"data":{"status":"ok","uptime":12.34,"timestamp":"2026-01-01T00:00:00.000Z"},"meta":null}

// GET /ready
{"success":true,"data":{"status":"ready","timestamp":"...","dependencies":{
  "database":{"status":"up","driver":"sqlite","latencyMs":0},
  "cache":{"status":"up","driver":"memory","latencyMs":0}}},"meta":null}

// GET /api/v1/version
{"success":true,"data":{"name":"ClearWood Furnitures","version":"0.1.0","env":"development",
  "drivers":{"db":"sqlite","cache":"memory","storage":"local","mail":"log","payment":"mock"}},"meta":null}

// GET /api/v1/settings/public
{"success":true,"data":{
  "payment.split.enabled":false,
  "site.currency":"INR",
  "site.email":"care@clearwood.local",
  "site.free_shipping_threshold":999900,
  "site.gst_percent":18,
  "site.name":"ClearWood Furnitures",
  "site.phone":"+91 99999 99999",
  "site.usp_line":"100% in-house manufacturing. Zero outsourcing.",
  "site.whatsapp":"919999999999"},"meta":null}
```

Note that `site.gst_percent` is a **number** and `payment.split.enabled` is a **boolean** — the
`valueType` column drives the decoding, which is how settings stay typed without a JSON column (D3).
`site.free_shipping_threshold` is **999900 paise = ₹9,999** (D5: money is always integer paise).

### 3. The error envelope

```powershell
curl http://localhost:7180/api/v1/nope                            # 404 NOT_FOUND
curl "http://localhost:7180/api/v1/settings/public?group=NOT%20OK" # 422 VALIDATION_ERROR + details
```

```jsonc
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /api/v1/nope does not exist",
    "details": null,
    "traceId": "b3f1…",
  },
}
```

Every error carries a `traceId` that matches the `x-request-id` response header and the log line.

A full request collection lives in [docs/api/00-foundation.http](docs/api/00-foundation.http)
(VS Code REST Client) and covers CORS preflight, a blocked origin and malformed JSON as well.

### 4. The browser

| Open                       | Expect                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------ |
| http://localhost:7180/docs | Swagger UI, ClearWood colours, 4 endpoints, 5 schemas                                |
| http://localhost:7181      | ivory storefront shell, **green "Online"** badge, driver list read live from the API |
| http://localhost:7182      | dark "ClearWood Admin" shell, same green badge, visually distinct                    |

A green badge on both apps proves the CORS allowlist, the credentialed requests and the response
envelope unwrapping all work end to end.

### 5. Database

```powershell
npm run db:studio     # Prisma Studio: AppSetting has 9 rows, AuditLog is empty
npm run db:seed       # run it again — still 9 rows (the seed is idempotent)
```

---

## How to verify Prompt 2 (catalog domain)

```powershell
npm run db:migrate    # applies catalog_core
npm run db:seed       # structure + demo catalog (SEED_DEMO defaults to on in development)
npm run db:seed       # run it a second time — every row count is identical
npm run db:studio     # inspect Category / Attribute / Product / NavigationItem
```

Expected seed output (the table is printed at the end of every run):

```
[seed:settings]     9 settings upserted
[seed:tax-classes]  4 tax classes upserted
[seed:attributes]   5 groups, 14 attributes, 95 values upserted
[seed:categories]   111 categories and 48 attribute links upserted
[seed:collections]  5 collections upserted
[seed:navigation]   4 menus and 128 items upserted
[seed:demo-catalog] 14 products, 49 variants, 84 media links upserted
```

Then, with `npm run dev` running:

```powershell
curl "http://localhost:7180/api/v1/catalog/categories/tree?depth=1"
curl http://localhost:7180/api/v1/catalog/categories/fabric-sofas
curl "http://localhost:7180/api/v1/catalog/attributes?categorySlug=fabric-sofas"
curl http://localhost:7180/api/v1/navigation/MAIN
```

What to look for:

| Check                 | Expectation                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tree                  | 12 roots, 111 categories in total; `sofas` has 21 children; `depth=1` returns only the roots                            |
| Kinds                 | `all-sofas` → `ALL`, `special-collection-sofas` → `SPECIAL_COLLECTION`, `make-your-own-sofas` → `MAKE_YOUR_OWN`         |
| Breadcrumbs           | `fabric-sofas` has `path` `sofas/fabric-sofas` and breadcrumbs `["sofas","fabric-sofas"]`                               |
| Attribute inheritance | `fabric-sofas` defines nothing of its own yet returns COLOUR, FABRIC, SEATER, LEG_TYPE, FILLING, ARM_STYLE from `sofas` |
| Attribute override    | `leather-sofas` returns FABRIC with `inheritedFrom: "leather-sofas"` and `isRequiredForCategory: true`                  |
| Navigation            | `MAIN` → `Furnitures` → `All Products` + 11 category groups; three `LEAD_FORM` items carry their `leadFormKey`          |
| Media                 | http://localhost:7180/media/seed/kabir-3-seater-fabric-sofa-01.svg renders (URLs come from the StorageDriver)           |
| Idempotency           | a second `npm run db:seed` changes no row count, and an edited category name survives                                   |

The full request collection is in [docs/api/02-catalog.http](docs/api/02-catalog.http).

---

## How to verify Prompt 3 (auth, RBAC, sessions, audit)

```powershell
npm run db:migrate    # applies auth_rbac
npm run db:seed       # 86 permissions, 5 roles, the bootstrap admin, 3 demo customers
npm run db:seed       # again — counts unchanged, and a revoked grant is NOT restored
npm run dev
```

Expected tail of the seed:

```
[seed:permissions]    86 permissions upserted (15 dangerous)
[seed:roles]          5 roles upserted (SUPER_ADMIN=86, ADMIN=79, CATALOG_MANAGER=36, ORDER_MANAGER=15, CONTENT_MANAGER=24)
[seed:admin-user]     bootstrap ADMIN created (admin@clearwood.local) — must change password on first login
[seed:demo-customers] 3 demo customers upserted
```

### 1. The admin panel (http://localhost:7182)

| Step                                                    | Expect                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Open `/` while signed out                               | redirected to `/login`                                                                           |
| Sign in with `admin@clearwood.local` / `ChangeMe@12345` | redirected to `/change-password` (the seeded account must change it)                             |
| Set a new password (min 10 chars)                       | lands on the dashboard showing your name, `ADMIN` and **79** permissions                         |
| Refresh the page                                        | still signed in — the session comes from the httpOnly cookie, not from storage                   |
| DevTools → Application → Local/Session Storage          | **empty** — no token is ever stored there                                                        |
| DevTools → Cookies                                      | `cw_adm_at` and `cw_adm_rt` are `HttpOnly`, `Path=/api/v1/admin`; only `cw_adm_csrf` is readable |
| Click **Sign out**                                      | back to `/login`, cookies cleared                                                                |

### 2. The API

```powershell
# sign in and keep the cookies
curl -i -c cookies.txt -X POST http://localhost:7180/api/v1/admin/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"admin@clearwood.local\",\"password\":\"ChangeMe@12345\"}'

# the bootstrap ADMIN must change its password first: until then -> 403 PASSWORD_CHANGE_REQUIRED
curl -b cookies.txt "http://localhost:7180/api/v1/admin/catalog/categories?depth=1"

# change it (a cookie-authenticated POST echoes the readable cw_adm_csrf cookie)
curl -b cookies.txt -X POST http://localhost:7180/api/v1/admin/auth/change-password `
  -H "Content-Type: application/json" -H "X-CSRF-Token: <value of cw_adm_csrf>" `
  -d '{\"currentPassword\":\"ChangeMe@12345\",\"newPassword\":\"<a new password>\"}'

# guard chain: authenticate(ADMIN) + requirePermission(catalog.category.read) -> 200 now
curl -b cookies.txt "http://localhost:7180/api/v1/admin/catalog/categories?depth=1"

# anonymous -> 401 NOT_AUTHENTICATED
curl -i "http://localhost:7180/api/v1/admin/catalog/categories"
```

| Check                                    | Expectation                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Login body                               | contains `tokens.accessToken` but **never** `refreshToken`                                                |
| Cookies                                  | `cw_adm_at`, `cw_adm_rt` (HttpOnly), `cw_adm_csrf` (readable)                                             |
| Wrong password vs unknown email          | byte-identical `401 INVALID_CREDENTIALS` bodies                                                           |
| 5 bad logins                             | 6th returns `ACCOUNT_LOCKED`; `LoginAttempt` rows written                                                 |
| Customer token on an admin route         | `401 TOKEN_INVALID` (and vice-versa)                                                                      |
| `CATALOG_MANAGER` → `POST /admin/roles`  | `403 FORBIDDEN` + an audited `PERMISSION_DENIED` row                                                      |
| Role change                              | `permissionVersion` bumps and the previous access token returns `401 TOKEN_EXPIRED`                       |
| Cookie-auth POST without `X-CSRF-Token`  | `403 CSRF_TOKEN_INVALID`; Bearer requests are exempt                                                      |
| Replayed refresh cookie                  | `401 TOKEN_REUSE` and the whole family is revoked                                                         |
| Bootstrap ADMIN before changing password | `403 PASSWORD_CHANGE_REQUIRED` everywhere except `/auth/me`, `/auth/sessions`, change-password and logout |
| `ADMIN` creates or grants `SUPER_ADMIN`  | `403 ROLE_NOT_GRANTABLE`; changing a SUPER_ADMIN is `403 ADMIN_USER_NOT_MANAGEABLE`                       |
| Disabling the last active SUPER_ADMIN    | `403 LAST_SUPER_ADMIN`, even for that SUPER_ADMIN                                                         |
| SUSPENDED / DISABLED admin               | sign-in, refresh and a live access token are all refused                                                  |
| OTP request (development)                | response carries `devCode`, so the flow is testable with no SMS provider                                  |

The full request collection is in [docs/api/03-auth.http](docs/api/03-auth.http) — it runs top to
bottom and covers the admin login, the guard chain, a 403, the customer OTP flow, refresh and logout.

> **Sessions are cookie-only in the browser.** Refresh tokens live exclusively in the httpOnly
> `cw_adm_rt` / `cw_cus_rt` cookies. The production Admin and Storefront frontends always refresh
> over those cookies; the `refreshToken` body field on `/refresh` exists solely for REST Client and
> the test suite and is rejected when `NODE_ENV=production`.

---

## How to verify Prompt 4 (media, renditions, galleries)

```powershell
$env:NODE_OPTIONS="--use-system-ca"
npm run db:migrate
npm run db:seed          # run it twice — the row counts must not move
npm run lint; npm run typecheck; npm test; npm run build
```

After seeding you should see:

| Table          | Rows |
| -------------- | ---- |
| `mediaFolder`  | 10   |
| `media`        | 84   |
| `mediaVariant` | 980  |
| `mediaUsage`   | 84   |

`mediaVariant > 0` is the proof that the demo images really went through the sharp pipeline rather
than being written straight to disk.

In the browser:

1. `npm run dev` and sign in at <http://localhost:7182> with `admin@clearwood.local` /
   `ChangeMe@12345`.
2. Click **Media** in the header to open `/media`.
3. Drag an image onto the dropzone (or just paste one from the clipboard) and watch the progress
   bar; re-drop the same file and it reports _already in library_ instead of storing it twice.
4. Click the thumbnail to open the detail drawer: renditions are listed with their real byte sizes,
   alt text/title/tags are editable, and clicking the image sets the focal point.
5. Attach it to a product, then call the public gallery with no credentials at all:
   <http://localhost:7180/api/v1/catalog/products/{slug}/gallery>. `PRIMARY` is always first, there
   is never more than one of it, and imagery belonging to another variant or colour is filtered out.

| What you try                                  | What you get                                              |
| --------------------------------------------- | --------------------------------------------------------- |
| Upload a `.png` that is really a shell script | `415` — the type comes from the magic bytes, not the name |
| Upload a file over `MAX_UPLOAD_SIZE_MB`       | `413 FILE_TOO_LARGE`                                      |
| Upload an SVG containing `<script>`           | stored sanitised, or rejected if it is still active       |
| `ORDER_MANAGER` opens the media library       | `403` — `media.asset.read` is not in that role            |
| Permanently delete an asset that is in use    | `409 MEDIA_IN_USE`; `?force=true` detaches, then deletes  |
| Tamper with a `/media-signed/*` signature     | `403 SIGNED_URL_INVALID` (or `SIGNED_URL_EXPIRED`)        |

The full request collection is in [docs/api/04-media.http](docs/api/04-media.http).

---

## How to verify Prompt 5 (admin catalog, inventory, import/export)

```powershell
$env:NODE_OPTIONS="--use-system-ca"
npm run db:migrate
npm run db:seed          # run it twice — the row counts must not move
npm run lint; npm run typecheck; npm test; npm run build
```

After seeding you should see:

| Table             | Rows |
| ----------------- | ---- |
| `brand`           | 3    |
| `inventoryLedger` | 46   |
| `productRelation` | 0    |
| `slugRedirect`    | 0    |

`inventoryLedger > 0` with balances that match `productVariant.stockQty` is the proof that stock
only ever moved through the ledger.

In the browser:

1. `npm run dev`, sign in at <http://localhost:7182>, then open **Catalog → Categories**.
2. Create "Recliner Sofas" under Sofas, drag it to a new position, and set a banner with the
   existing MediaPicker.
3. Load <http://localhost:7180/api/v1/catalog/categories/tree> — the new node is already there with
   the right path and position, with no restart and no cache flush.
4. Delete throwaway nodes with each strategy and read the impact preview first.

| What you try                                         | What you get                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `PATCH` with a `version` someone else already bumped | `409 STALE_RESOURCE` carrying the current version                           |
| Delete a category that still has children            | `409 CATEGORY_IN_USE` with the child and product counts                     |
| Rename a slug twice                                  | two redirect rows, both pointing at the final slug — never chained          |
| Delete an attribute value a variant uses             | `409 ATTRIBUTE_IN_USE` with the referencing counts                          |
| Generate a matrix over the cap                       | `422 VARIANT_MATRIX_TOO_LARGE`                                              |
| Publish a product with a broken image                | `422 PRODUCT_NOT_PUBLISHABLE` listing every blocker at once                 |
| Two simultaneous stock adjustments                   | both land, or the loser gets `409 INVENTORY_CONFLICT` — never a lost update |
| Release more stock than is reserved                  | clamped to the reservation; `reservedQty` never goes negative               |
| Retry a create with the same `Idempotency-Key`       | the original response, replayed with `Idempotent-Replay: true`              |
| Export a product named `=cmd()`                      | the cell is written as `'=cmd()` so no spreadsheet executes it              |
| Import inventory without `catalog.inventory.update`  | `403` before a single row is parsed                                         |

The full request collection is in
[docs/api/05-admin-catalog.http](docs/api/05-admin-catalog.http).

---

## How to verify Prompt 6 (pricing engine)

```powershell
$env:NODE_OPTIONS="--use-system-ca"
npm run db:migrate
npm run db:seed          # run it twice — the row counts must not move
npm run lint; npm run typecheck; npm test; npm run build
```

After seeding you should see:

| Table                  | Rows |
| ---------------------- | ---- |
| `customerGroup`        | 4    |
| `shippingZone`         | 4    |
| `shippingPincode`      | 40   |
| `shippingPincodeRange` | 6    |
| `shippingRate`         | 12   |
| `coupon`               | 5    |
| `tierPrice`            | 8    |
| `priceAdjustment`      | 8    |

In the browser:

1. `npm run dev`, sign in at <http://localhost:7182>, then open **Pricing → Price simulator**.
2. Pick a demo sofa. Switch the fabric option from Cotton to Genuine Leather and watch the unit
   price move — the new `ATTRIBUTE_VALUE` adjustment appears in the waterfall by name.
3. Set the quantity to 5. A `TierPrice` row takes over the unit base; the trace says which one.
4. Apply `WELCOME10` and enter pincode `400001`. Shipping, GST and rounding all appear as their own
   components, and the components sum **exactly** to the grand total.
5. Change a price adjustment under the admin, then re-run the public quote — the new number is
   served immediately, which is the cache invalidation working.

| What you try                               | What you get                                                        |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Quote the same cart twice                  | an identical `contextHash` and an identical total                   |
| An expired coupon                          | `isValid:false` with rejection code `EXPIRED` — never a 500         |
| A coupon below its minimum subtotal        | rejection code `MIN_SUBTOTAL_NOT_MET`, with the shortfall reported  |
| More concurrent redemptions than the limit | the surplus gets `409 COUPON_EXHAUSTED`; `usedCount` never overruns |
| An unserved pincode                        | `isServiceable:false` with no rates, and the quote still calculates |
| A Maharashtra buyer vs. a Karnataka buyer  | CGST + SGST in the first case, IGST in the second                   |
| A component list that does not sum         | a 500 from the engine's own invariant assertion — it fails loudly   |

The full request collection is in [docs/api/06-pricing.http](docs/api/06-pricing.http).

---

## How to verify Prompt 7 (storefront catalog, facets, search, PDP)

```powershell
$env:NODE_OPTIONS="--use-system-ca"
npm run db:migrate
npm run db:seed          # run it twice — the row counts must not move
npm run lint; npm run typecheck; npm test; npm run build
```

After seeding you should see:

| Table               | Rows |
| ------------------- | ---- |
| `product`           | 71   |
| `productVariant`    | 165  |
| `searchDocument`    | 190  |
| `searchSynonym`     | 27   |
| `productStat`       | 71   |
| `collectionProduct` | 58   |

`collectionProduct > 0` is the proof that AUTOMATIC collection rules are finally being evaluated —
the table was empty from Prompt 2 until now.

With `npm run dev` running:

1. `GET http://localhost:7180/api/v1/catalog/products?categorySlug=sofas` — facets come back with
   non-zero counts, and `pricingBasis` is `DEFAULT_GROUP`.
2. Add `&attributeValueIds=<a colour id>` — every other facet's counts change; the colour facet's do
   not, because a dimension is counted with its own selection removed.
3. `GET /api/v1/catalog/products/kabir-3-seater-fabric-sofa?pincode=400001` and compare
   `data.price.grandTotalPaise` with `POST /api/v1/pricing/quote` for the same selection. They are
   the same number, because the PDP returns the Prompt 6 breakdown verbatim.
4. `GET /api/v1/search?q=couch` returns sofas — the synonym is doing the work.
5. Rename a product slug in the admin, then `GET /api/v1/catalog/resolve?path=/<old-slug>` — it
   answers `REDIRECT` with `statusCode: 301`.
6. Open <http://localhost:7182/search/analytics> and the queries you just ran are listed, with the
   zero-result ones offering a one-click "create synonym".

| What you try                              | What you get                                                    |
| ----------------------------------------- | --------------------------------------------------------------- |
| Filter by a category with children        | Products in the descendants too, via the materialised path      |
| Two values of one attribute               | OR — the union                                                  |
| One value each from two attributes        | AND — the intersection                                          |
| Page through any sort                     | No duplicate and no missing row, guaranteed by an `id` tiebreak |
| Cursor from a different filter set        | `422` — the cursor is fingerprinted against its filters         |
| `limit=200`                               | `422` — capped by `catalog.max_page_size`                       |
| `sort=RELEVANCE` with no `q`              | `422` — relevance needs something to be relevant to             |
| `q=a`                                     | `422 SEARCH_QUERY_TOO_SHORT`                                    |
| `q='; DROP TABLE Product; --`             | A harmless three-word search; the table is untouched            |
| Re-request a listing with `If-None-Match` | `304`                                                           |
| Edit a product in the admin               | The next public call already shows it, index included           |
| An invalid operator in a collection rule  | `422` before anything reaches Prisma                            |

The full request collection is in [docs/api/07-storefront.http](docs/api/07-storefront.http).

---

## How to verify Prompt 8 (cart, wishlist, addresses)

1. As a **guest** on <http://localhost:7181>, add a sofa in Beige/Cotton, then the same sofa in
   Beige/Leather — two lines. Add Beige/Cotton again: the quantity becomes 2 and no third line
   appears. That is the `lineKey` doing its job.
2. Apply `WELCOME10` and enter pincode `400001`. The ETA and the discount both appear.
3. `POST /api/v1/pricing/quote` with the same items, coupon and pincode. Every component —
   subtotal, discount, shipping, tax, rounding and grand total — matches the cart exactly, because
   the cart returns the engine's breakdown verbatim.
4. Log in as `aarav.mehta@example.com` / `CustomerDemo@2026`. The guest lines merge into the
   existing account cart, overlapping quantities are summed, and the guest cart ends up `MERGED`
   rather than deleted.
5. Open <http://localhost:7182/carts> as an admin and find that cart, plus the seeded abandoned one.
   The detail drawer shows a **live** re-quote, not the stored snapshot.

| What you try                                | What you get                                                      |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `GET /cart` as a brand-new visitor          | An empty cart and **no** cookie — a read never mints an identity  |
| First `POST /cart/items`                    | An httpOnly, signed `cw_cart` cookie                              |
| Tamper with one byte of that cookie         | A fresh empty cart, silently. Never a 500, never an explanation   |
| Ten parallel identical adds                 | One line, quantity 10                                             |
| Two simultaneous quantity updates           | Both applied, or one `409 CART_CONFLICT`. Never a lost update     |
| Add anything at all                         | `ProductVariant.reservedQty` is unchanged — carts never reserve   |
| A line whose stock ran out                  | A BLOCKING `OUT_OF_STOCK` issue, and checkout is disabled         |
| `POST /cart/validate?autoFix=true`          | Quantities clamped, with every change listed in `fixes[]`         |
| A price that moved since you added the line | A `priceChanges[]` entry; the price shown is still the live one   |
| `POST /cart/merge` twice                    | `merged: true`, then `merged: false` — nothing changes            |
| Another customer's address id               | `404`, not `403` — ids cannot be enumerated                       |
| A shared wishlist link                      | Products only; no name, email or customer id anywhere in the body |
| `/admin/carts` as a CATALOG_MANAGER         | `403` — the gate is `order.customer.read`                         |

The full request collection is in [docs/api/08-cart.http](docs/api/08-cart.http).

---

## How to verify Prompt 9A (orders, payments, the Route split)

Run the API with `PAYMENT_DRIVER=mock` — no Razorpay account and no network are needed.

1. As a guest on <http://localhost:7181>, add something to the cart and go to `/checkout`. Fill in
   the address, then pick a payment method.
2. `POST /api/v1/admin/payments/split-simulate` with `{ "amountPaise": 600000 }`, or open
   <http://localhost:7182/payments/split-rules> and type 6000 into the simulator. Both answer
   **PRIMARY ₹5,000 + PARTNER_A ₹1,000**, summing to exactly ₹6,000.
3. Open the seeded orders at <http://localhost:7182/admin/orders> via the API, or
   `GET /api/v1/admin/orders/:id` — the detail carries the payments, the transfers, the allocations,
   the reservations and a **ledger check that must come back `ok: true`**.
4. Replay that order's webhook from `/api/v1/admin/webhooks/:id/replay`. Nothing changes: no second
   state transition, no second transfer, no second ledger row.
5. Abandon a checkout you have placed but not paid, then look at the variant's `reservedQty` — it is
   back where it started, and the coupon slot has been returned.

| What you try                                    | What you get                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Send `amountPaise` in the place body            | `422` — the schema is strict, so a client price cannot be ignored      |
| Change a product price after an order is paid   | The order renders byte-identically; it replays a frozen snapshot       |
| Change the price BETWEEN init and place         | `409 PRICE_CHANGED` with the new breakdown. No order, no holds taken   |
| Place an order                                  | `reservedQty` rises by exactly the ordered quantity                    |
| Pay for it                                      | The reservation is consumed into an `ORDER_FULFILLED` ledger row       |
| Let the payment window lapse                    | The sweep releases the stock and the coupon; a paid order is untouched |
| Deliver the same webhook 5× at once             | One state change, four `DUPLICATE` rows, one ledger row                |
| Deliver a webhook BEFORE the verify call        | The order confirms anyway; the later verify is a happy no-op           |
| Deliver an unsigned webhook                     | `400`, and nothing is stored as valid                                  |
| A payout leg fails after a successful capture   | Payment stays `CAPTURED`, order stays `CONFIRMED`, transfer `FAILED`   |
| `POST /admin/orders/:id/retry-transfers`        | Only the failed legs are retried; the ledger reconciles                |
| COD above `COD_MAX_ORDER_PAISE`                 | `422 COD_LIMIT_EXCEEDED`                                               |
| COD below it                                    | Confirmed with no provider call and no transfers                       |
| Track an order with the wrong email             | `404` — the same answer as a number that never existed                 |
| `/admin/orders` as a CATALOG_MANAGER            | `403`. As an ORDER_MANAGER, `200`                                      |
| A split-rule write as an ORDER_MANAGER or ADMIN | `403` — only SUPER_ADMIN holds `payment.*`                             |
| A second active REMAINDER rule                  | `409 DUPLICATE_REMAINDER_RULE`                                         |

The full request collection is in
[docs/api/09a-orders-payments.http](docs/api/09a-orders-payments.http).

---

## Prompt 10A — CMS verification

| Do this                                                    | You should see                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/v1/content/home`                                  | 13 blocks, each hydrated: product cards priced, categories and FAQs resolved |
| Repeat with the returned `ETag` as `If-None-Match`          | `304` with no body                                                    |
| `GET /api/v1/content/home?device=MOBILE`                    | `DESKTOP_ONLY` blocks gone                                            |
| `GET /api/v1/content/pages/privacy-policy`                  | A `RICH_TEXT` block whose HTML was sanitised when it was saved        |
| `GET /api/v1/content/pages/<a draft slug>`                  | `404` — never `403`; a draft does not exist for the public            |
| Publish a page with no blocks                               | `422 PAGE_NOT_PUBLISHABLE` listing **every** blocker at once          |
| Publish a page whose block points at a deleted product      | `422` with `BLOCK_REFERENCE_MISSING` and the offending ids            |
| Save a `CUSTOM_HTML` block containing `<script>`            | Stored sanitised; the original survives in `rawConfig` for editing    |
| Rename a page's slug, then `GET /api/v1/catalog/resolve`    | `type: REDIRECT`, `statusCode: 301`                                   |
| Restore revision 1                                          | A **new** revision is written; the count goes up, never down          |
| Add a nav item of type `PAGE` pointing at a draft           | `422` — the main navigation may not contain a 404                     |
| Add a nav item with url `//evil.example.com`                | `422` — a protocol-relative URL resolves off-site                     |
| Reorder the MAIN menu, then `GET /api/v1/navigation/MAIN`   | The new order, on the very next call                                  |
| `PUT /api/v1/admin/content/settings` with a `payment.*` key | `422` — the content screen is not a back door                         |
| `GET /sitemap-pages.xml`                                    | Published pages only; `noIndex` and drafts absent, `lastmod` present  |
| `GET /robots.txt`                                           | Rendered from settings, with the sitemap URL                          |

The full request collection is in [docs/api/10a-cms.http](docs/api/10a-cms.http) — it runs top to
bottom and includes the whole admin walkthrough.

---

## Redis foundation — verification

Nothing here is needed for local development: `CACHE_DRIVER=memory` remains the default. To try
the shared cache locally, run any Redis 7 on the reserved port 6380, for example
`docker run -d --name clearwood-redis -p 127.0.0.1:6380:6379 redis:7.4-alpine`.

```powershell
npm run lint; npm run typecheck --workspace backend; npm run check
cd backend; npx vitest run                                   # Redis suites report as skipped
$env:CLEARWOOD_TEST_REDIS_URL="redis://127.0.0.1:6380"        # localhost only
npx vitest run tests/redis-integration.test.ts tests/redis-app.test.ts
```

| Do this                                                                                        | You should see                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `CACHE_DRIVER=redis`, `REDIS_URL=redis://127.0.0.1:6380`, `GET /ready`                         | `status: ready`, cache `driver: redis`, `up`                 |
| Stop Redis, `GET /ready`                                                                       | HTTP 200, `status: degraded`; the storefront keeps answering |
| Start Redis again                                                                              | a `redis ready` log line; `/ready` back to `ready`           |
| `GET /api/v1/catalog/products/<slug>`, then `redis-cli -p 6380 --scan --pattern 'cw:sf:pdp:*'` | the cached product page                                      |
| Edit that product in the admin, scan again                                                     | no keys: every worker rebuilds it from MySQL                 |
| `TRUST_PROXY=true` and start the API                                                           | `Invalid environment configuration` naming `TRUST_PROXY`     |

---

## Prompt 3 (catalog integrity) — verification

```powershell
cd backend
npx vitest run tests/catalog-integrity.test.ts tests/catalog-integrity-migration.test.ts tests/cache-driver.test.ts tests/cache-invalidation.test.ts tests/query-budgets.test.ts
$env:CLEARWOOD_CATALOG_BASELINE="1"; npx vitest run tests/catalog-scale-baseline.test.ts   # prints [scale] timings + EXPLAIN
```

| Do this                                                    | You should see                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Create two variants with the same options (any order)      | second is 409 `VARIANT_COMBINATION_EXISTS`                                                  |
| `set-default` on two variants at once                      | exactly one `isDefault` row afterwards                                                      |
| Soft-delete a product, create a new one with the same name | the new product gets the original slug                                                      |
| Restore the deleted one                                    | it gets `<slug>-2`                                                                          |
| Edit a product image                                       | only that product's `sf:pdp:<slug>:*` keys, listings, suggestions and CMS pages are dropped |

---

## Prompt 4 (storefront listing) — verification

```powershell
cd backend
npx vitest run tests/storefront-listing.test.ts tests/storefront-api.test.ts tests/query-budgets.test.ts tests/search.test.ts
$env:CLEARWOOD_LISTING_BENCHMARK="1"; npx vitest run tests/catalog-listing-benchmark.test.ts   # [bench] lines: wall, queries, db time, rows read, bytes
```

| Do this                                                                     | You should see                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/v1/catalog/products?categorySlug=sofas&includeFacets=false` twice | the second answer served from `sf:list:grid:anon:*`                                                |
| Change a variant price in the admin, then `sort=PRICE_ASC`                  | the card shows the new price at once; its position follows once `ProductListingIndex` is refreshed |
| Set `catalog.show_out_of_stock` to `false`                                  | out-of-stock products disappear from every grid                                                    |
| `GET /api/v1/catalog/filters?categorySlug=sofas`                            | facets from SQL aggregates only (about 6 queries on the seed)                                      |

## Prompt 5 (catalog correctness) — verification

```powershell
cd backend
npx vitest run tests/catalog-correctness.test.ts tests/listing-index-migration.test.ts tests/storefront-listing.test.ts
npm run listing:reconcile          # one leased pass: {"ran":true,"windows":…,"repriced":…,…}
$env:CLEARWOOD_LISTING_BENCHMARK="1"; $env:CLEARWOOD_LISTING_BENCHMARK_PRODUCTS="50000"; $env:CLEARWOOD_LISTING_BENCHMARK_REBUILD="1"
npx vitest run tests/catalog-listing-benchmark.test.ts
```

| Do this                                                             | You should see                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Set a product `CATALOG_ONLY`, then `SEARCH_ONLY`                    | CATALOG_ONLY: in its category and its page, absent from `/search`; SEARCH_ONLY: the reverse for listings, its page still opens |
| `POST /api/v1/catalog/products/batch` with a draft's id             | the draft is not in the answer                                                                                                 |
| Give a customer group `discountBp: 1000`, sign in as a member       | cards, PDP and `/pricing/quote` show 10% off, with one `CUSTOMER_GROUP` component; `pricingBasis` names the group              |
| Create a price rule starting in two minutes, wait, `sort=PRICE_ASC` | within `LISTING_RECONCILE_INTERVAL_SECONDS` of its start the order follows the new price, with no admin write                  |
| `npm run listing:reconcile` twice at once                           | one prints `"ran":true`, the other `"ran":false` (or both true, one after the other - never overlapping)                       |
| Reserve the last unit of a variant                                  | it leaves `inStockOnly` grids at once; a release brings it back                                                                |
| A grid page's `image.sources`                                       | SMALL and MEDIUM renditions only; the PDP gallery keeps every rendition                                                        |

## Dynamic catalog + admin catalog management — verification

```powershell
cd backend
npx vitest run tests/catalog-management.test.ts tests/seed-idempotency.test.ts tests/catalog.test.ts
npm run db:seed                    # twice: the second run creates nothing and changes nothing
```

Requests in `docs/api/05b-catalog-management.http`.

| Do this                                                                  | You should see                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Deactivate `sofas` in the admin                                          | the whole Sofas subtree leaves the tree, menus, listings, search and category pages; reactivating brings back exactly what was live |
| `PUT /admin/catalog/settings` `{"newArrivalDays": 7}`                    | `/catalog/products?categorySlug=new-arrivals` shrinks to the last week's launches plus flagged products, no cache flush             |
| Publish a product with a `publishAt` two minutes ahead                   | `publication: SCHEDULED` in the admin list; within a reconcile interval of that time it lists, searches and shows its badges        |
| `SET_MERCHANDISING` with `featuredUntil` in the past                     | its search boost and FEATURED badge drop at the next reconcile pass                                                                 |
| Reorder `/admin/catalog/categories/:id/products`                         | `sort=CURATED` on that category follows the new order at once                                                                       |
| `POST /api/v1/enquiries` with `formKey: contract-work`                   | 201 with a reference; the enquiry is in `/admin/enquiries`, never in an order                                                       |
| Re-run the seed after moving, deactivating or deleting a seeded category | every admin change is still there; nothing deleted comes back                                                                       |

## Catalog hardening — verification

```powershell
cd backend
npx vitest run tests/catalog-hardening.test.ts tests/seed-idempotency.test.ts
npm run db:seed                    # after editing a tax rate and deleting a menu item: both stay as you left them
```

Requests in `docs/api/05c-catalog-hardening.http`.

| Do this                                                                                | You should see                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Change a tax class rate or the default customer group, delete a menu item, re-seed     | the rate, the single default and the deletion all survive; nothing is re-created                   |
| Import a PRODUCT CSV that changes a price and a category                               | listing, PDP, search and category counts follow at once; menus and settings caches are not dropped |
| `PUT /admin/catalog/products/:id/relations` with the same product twice under one type | 422, `details.repeated`; a deleted product is refused too                                          |
| Open that product's PDP                                                                | `relationGroups` in type order; hidden or draft targets never appear                               |
| `GET /catalog/products/:slug/related?type=ALTERNATIVE` with none curated               | `[]` - never the category fallback                                                                 |
| File a product under `custom-hotel-furniture`                                          | 422 `CATEGORY_NOT_PURCHASABLE` (admin, bulk and import alike)                                      |
| `GET /catalog/categories/contract-based-work/landing`                                  | `category.kind: SERVICE`, `leadFormKey: contract-work`, no products                                |
| Turn the SALE badge off in catalog settings                                            | it leaves cards, the PDP, search results and cached CMS product blocks at once                     |

---

## Repository layout

```
clearwood/
  backend/            Node 20 + Express 4 + TypeScript + Prisma
    prisma/           schema.prisma, migrations/, seed.ts
      seed/           01-settings … 07-demo-catalog, media-assets, data/ (pure data files)
    src/
      config/         env (Zod), logger (pino), prisma client
      drivers/        cache | storage | mail  (interface + local impl + documented TODO stub)
      middleware/     requestId, httpLogger, validate, rateLimiter, notFound, errorHandler, asyncHandler
      routes/ controllers/ services/ repositories/    <- R1 layering
      docs/           OpenAPI registry + document
      utils/          AppError, response helpers, jsonColumn, slug
    tests/            Vitest + Supertest
  frontend/web/       React 18 + Vite + TS + Tailwind  (storefront, port 7181)
  frontend/admin/     React 18 + Vite + TS + Tailwind  (admin panel, port 7182)
  shared/             constants, enums, API + catalog types, Zod schemas, money utils, Tailwind preset
  infra/              nginx + pm2 configs (Prompt 17)
  docs/               constitution, roadmap, migration plan, api/*.http
```

## Scripts

| Script                                                      | What it does                          |
| ----------------------------------------------------------- | ------------------------------------- |
| `npm run dev`                                               | API + storefront + admin concurrently |
| `npm run dev:backend` / `dev:web` / `dev:admin`             | one surface at a time                 |
| `npm run build`                                             | shared → backend → web → admin        |
| `npm test`                                                  | shared + backend suites               |
| `npm run typecheck` / `lint` / `format`                     | quality gates                         |
| `npm run db:migrate` / `db:seed` / `db:studio` / `db:reset` | Prisma workflows                      |

## Non-negotiables

Read [.github/copilot-instructions.md](.github/copilot-instructions.md) before contributing, and
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) for the full constitution. The short version:
layered backend (routes → controller → service → repository), Zod on every input (422 on failure),
one response envelope, one error middleware, everything under `/api/v1`, everything documented in
OpenAPI, no hardcoded business values, money in integer paise, and a CORS allowlist that is never `*`.

---

## Going live later

See [docs/DB_MIGRATION_PLAN.md](docs/DB_MIGRATION_PLAN.md) for the exact SQLite → MySQL 8 procedure,
plus the matching switches for Redis, S3, SMTP and Razorpay. In every case the application code is
untouched — only `backend/.env` changes.

## Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE 7180/7181/7182`                                           | the ports are reserved; stop whatever holds them rather than changing the port                                                                                      |
| Storefront badge is red                                               | the API is not running, or `CORS_ORIGINS` does not list the frontend origin                                                                                         |
| `Invalid environment configuration` on boot                           | the message lists every offending key; compare with `backend/.env.example`                                                                                          |
| `prisma generate` fails with `unable to get local issuer certificate` | corporate TLS interception — run installs with `$env:NODE_OPTIONS="--use-system-ca"` (Node 20+ with a system CA store) or set `NODE_EXTRA_CA_CERTS` to your root CA |
| `npm install` reports skipped install scripts                         | run `npm approve-scripts --allow-scripts-pending` (npm 11+) so Prisma and esbuild can fetch their binaries                                                          |
| `/ready` says `degraded`                                              | Redis is unreachable; reads are served from MySQL and rate limits count per process until it returns — check `REDIS_URL`                                            |
