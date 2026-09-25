# ClearWood Furnitures — Project Context (The Constitution)

> This file is the single source of truth for the whole build.
> Every prompt (1 → 17) must be read against this document.
> **Nothing in this file may be dropped, weakened or "simplified" by a later prompt.**

---

## 1. Product

**ClearWood Furnitures** — a premium Indian furniture e-commerce platform.

- **USP:** 100% in-house manufacturing, **zero outsourcing**, every product manufactured individually.
- Supports **made-to-order / customization** — "Make your own &lt;X&gt;" flows.
- **Three surfaces:**
  1. Public storefront (React SPA)
  2. Separate admin panel (moves to its own domain later)
  3. REST API (shared by both)

---

## 2. Current environment — LOCAL ONLY

There is **no domain, no hosted database, no S3 bucket and no Razorpay account yet.**

Therefore **every external dependency sits behind a driver interface selected by an env var**, so
switching later is a **config change, never a code change**:

| Concern | Abstraction       | Now             | Later                 |
| ------- | ----------------- | --------------- | --------------------- |
| DB      | Prisma datasource | `sqlite` file   | `mysql` 8             |
| Cache   | `CacheDriver`     | `memory`        | `redis`               |
| Storage | `StorageDriver`   | `local` disk    | `s3`                  |
| Mail    | `MailDriver`      | `log` (console) | `smtp`                |
| Payment | `PaymentDriver`   | `mock`          | `razorpay` (Prompt 9) |

**Hard constraint:** do **not** install or require Docker, MySQL or Redis. Everything must run with
only **Node 20 + npm** on a clean Windows machine, offline.

---

## 3. Folder structure (never change)

```
clearwood/
  backend/            Node 20 + Express 4 + TypeScript + Prisma
  frontend/web/       React 18 + Vite + TS + Tailwind   (storefront)
  frontend/admin/     React 18 + Vite + TS + Tailwind   (admin panel)
  shared/             shared types, Zod schemas, enums, constants, money utils
  infra/              nginx + pm2 configs (Prompt 17)
  docs/               constitution, roadmap, api/*.http files
```

- Root npm workspaces: `["backend", "frontend/web", "frontend/admin", "shared"]`
- TS path alias `@shared/*` → `shared/src/*` in **every** app.

---

## 4. Reserved ports (never change)

| Service              | Port     |
| -------------------- | -------- |
| Backend API          | **7180** |
| Storefront web       | **7181** |
| Admin web            | **7182** |
| _(reserved)_ Adminer | 7183     |
| _(reserved)_ MySQL   | 3380     |
| _(reserved)_ Redis   | 6380     |

---

## 5. Database discipline (critical — keeps SQLite → MySQL painless)

| #      | Rule                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | The Prisma provider is read from env so it can be switched in one place. Prisma forbids `env()` in the `provider` argument, so `backend/scripts/sync-prisma-provider.cjs` applies `DATABASE_PROVIDER` to `schema.prisma` before every generate/migrate. **Never edit that line by hand.** |
| **D2** | Do **NOT** use Prisma `enum`. Use `String` columns + TS const unions exported from `shared/`.                                                                                                                                                                                             |
| **D3** | Do **NOT** use the `Json` scalar. Use `String` columns holding JSON, with typed `jsonColumn<T>()` parse/serialize helpers in `backend/src/utils/jsonColumn.ts`.                                                                                                                           |
| **D4** | Do **NOT** use `@db.*` native type attributes or MySQL-only features (fulltext, generated columns).                                                                                                                                                                                       |
| **D5** | **Money is stored as INTEGER PAISE.** Never float. Format to rupees only at the UI edge.                                                                                                                                                                                                  |
| **D6** | Every model has `id` (cuid), `createdAt`, `updatedAt`; user-data models also have `deletedAt` (soft delete).                                                                                                                                                                              |
| **D7** | `docs/DB_MIGRATION_PLAN.md` documents the exact steps to move to MySQL 8 later: change `DATABASE_PROVIDER` + `DATABASE_URL`, regenerate migrations, run the data export/import script.                                                                                                    |

---

## 6. Non-negotiable engineering rules

| #       | Rule                                                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**  | Backend layering: **routes → controller → service → repository (Prisma)**. No Prisma inside controllers.                                                                                                                                             |
| **R2**  | Every body / query / param validated with **Zod**. Invalid input ⇒ **422**.                                                                                                                                                                          |
| **R3**  | **One response envelope, no exceptions** (see below).                                                                                                                                                                                                |
| **R4**  | Single central error middleware + typed `AppError` class. **No stack traces in production responses.**                                                                                                                                               |
| **R5**  | All list endpoints accept `page`, `limit` (max 100), `sort`, `order` and return `meta {page,limit,total,totalPages,hasNext}`.                                                                                                                        |
| **R6**  | All routes under `/api/v1`.                                                                                                                                                                                                                          |
| **R7**  | Every endpoint auto-documented in OpenAPI, browsable at `/docs`.                                                                                                                                                                                     |
| **R8**  | **No hardcoded business values.** Anything an admin might change lives in DB settings/config tables.                                                                                                                                                 |
| **R9**  | Everything customer-facing is **DYNAMIC**: adding a category / product / attribute / banner / FAQ in admin must appear on the storefront with **zero code change**.                                                                                  |
| **R10** | Security: `helmet`, CORS **allowlist (never `*`)**, `express-rate-limit`, `hpp`, `compression`, `httpOnly`+`sameSite` cookies, **argon2** password hashing, secrets redacted from logs, Prisma parameterised queries only, **no secrets committed**. |
| **R11** | Every prompt ships: code + migration (if any) + `docs/api/*.http` test file + updated OpenAPI + README verification steps + passing tests.                                                                                                           |
| **R12** | **Never break earlier prompts.** Run the full test suite before declaring done.                                                                                                                                                                      |
| **R13** | Conventional commits.                                                                                                                                                                                                                                |

### R3 — the response envelope

```jsonc
// success
{ "success": true, "data": <any>, "meta": <object|null> }

// error
{
  "success": false,
  "error": {
    "code": "SNAKE_CASE",
    "message": "...",
    "details": <any|null>,
    "traceId": "<uuid>"
  }
}
```

---

## 7. Design system tokens (used from Prompt 12 — recorded now)

**Vibe:** warm, editorial, premium; generous whitespace, soft rounded cards, large serif headlines.

| Token            | Value     | Meaning                         |
| ---------------- | --------- | ------------------------------- |
| `--cw-bg`        | `#FAF7F2` | warm ivory page background      |
| `--cw-surface`   | `#FFFFFF` | card / surface                  |
| `--cw-surface-2` | `#F2ECE3` | section band                    |
| `--cw-ink`       | `#1E1A16` | primary text                    |
| `--cw-ink-soft`  | `#6B6058` | secondary text                  |
| `--cw-clay`      | `#B4613A` | primary CTA accent (terracotta) |
| `--cw-clay-dark` | `#8F4A2B` | CTA hover / pressed             |
| `--cw-walnut`    | `#8A5A3B` | wood accent                     |
| `--cw-sage`      | `#7E8C77` | secondary accent                |
| `--cw-line`      | `#E3DACE` | hairline / border               |
| `--cw-success`   | `#2E7D5B` | success                         |
| `--cw-danger`    | `#B23B3B` | danger                          |

- **Radii:** sm `8`, md `14`, lg `22`, pill `999`
- **Shadow:** `0 10px 30px rgba(30,26,22,.08)`
- **Fonts:** display `"Fraunces"` / `"Playfair Display"` (serif headings), body `"Inter"`
- **Container:** `1280px`
- **Section padding:** `96px` desktop / `56px` mobile
- **Breakpoints:** `360 / 640 / 768 / 1024 / 1280 / 1536` — mobile-first, fully responsive, **AA contrast**
- **Motion:** `framer-motion` 200–400ms ease-out, respect `prefers-reduced-motion`

> These tokens are implemented once in `shared/tailwind-preset.cjs` and consumed as a Tailwind
> **preset** by both frontends, so the two apps can never drift.

---

## 8. Site map / menu (built later — recorded now so nothing is lost)

Top nav **"Furnitures"** (clicking it goes to Home) → **All Products**. Mega-menu groups:

- **Sofas:** All Sofas, Fabric, Wooden Frame, U-Shaped, Curved, Contemporary, Minimalist, 3-Seater,
  2-Seater, Single-Seater, 3+1+1 Sofa Sets, Sofa-cum-Beds, L-Shaped, Leather, Chaise Loungers,
  Outdoor Sofas, Diwans, Office Sofas, Swing Sofas, Special Collection, Make your own Sofas
- **Chairs:** All Chairs, Lounge, Armchairs, Wingback, Swing, Rocking, Office, Study, Gaming,
  Executive & Director, Cafeteria & Visitor, Special Collection Chairs, Make your own Chairs
- **Seating:** All Seating, Stools, Benches, Loveseats, Ottomans & Pouffes, Special Collection, Make your own
- **Sofa Chairs:** All, Single-Seater, Dual-Seater, Special Collection, Make your own
- **Tables:** All Tables, Coffee Tables, Coffee Table Sets, Side Tables, Nesting Tables,
  Sofa Side Tables, Special Collection, Make your own
- **Recliners:** All, Single-Seater, Dual-Seater, Triple-Seater, Special Collection
- **Dining:** All Dining Sets, 9/8/7/6/5/4/3/2/1-Seater Dining Sets, Special Collection, Make your own
- **Balcony Furniture:** Balcony Sets, Balcony Chairs, Balcony Tables, Swings, Special Collection, Make your own
- **Outdoor Furniture:** All Outdoor Sets, Table & Chair Sets, Sofa Sets, Loungers, Special Collection, Make your own
- **Mattresses:** All, King, Queen, Double Bed, Ortho-Zen, Foam, Special Collection, Make your own
- **Bedroom Headboard:** All Bedroom Headboard, Bedroom Headboard, Bedroom Legboard, Headboard
  Cushion, Special Collection Bedroom HeadBoard, Make your own Bedroom Headboard
- **Furniture Pillows:** All Pillows, Set of 6/5/4/3/2 Pillows, Cylinder, Spherical, Body, Big
  Floor, Rectangular, Square, Triangle, Knot Ball, Leather, Chair/Floor Pillows, Special
  Collection Pillows, Make your own Pillows
- **Furniture Accessories:** All Accessories, Sofa Legs, Sofa Diamonds, Screws / Nails, Table
  Legs, Chair Legs, Swing Cable / Rope, Hooks, Sofa Sponge Cushion, Foam, Exclusive Accessories,
  Make your own Accessories
- **Complete Interior Solutions:** Living Room, Bedroom, Kitchen, Hall, Lobby, Office,
  Special Collection, Make your own
- **New Arrivals**

**Contract Based Work** is its own top-level entry (a service line, kind `SERVICE`, enquiry form
`contract-work`): Custom Furnitures, Custom Hotel / Cafe / Restaurant / Lobby / Office / Home
Furniture, Customized Interior Designer Furniture, Customized Bank Furnitures. Fresh installs seed
the full names ("Fabric Sofas"); the seed is create-only, so an existing database keeps the names
its admin has (see §47).

**Lead-capture items** opening a modal form (Name, Phone, Pincode, Email, Message; extra fields
admin-configurable): **Home Interiors**, **Bulk Order**, **Become a Partner**.

**Global UI:** fully functional search with suggestions, wishlist, cart, profile, track order,
help center, FAQ, phone number, price-range filters, floating WhatsApp button bottom-right.

---

## 9. Payments (Prompt 9 — recorded now)

- **Razorpay with Route split payments** to **2 linked accounts**.
- Example: order ₹6000 ⇒ ₹5000 to Account A, ₹1000 to Account B.
- Split rules are **DB-driven and admin-editable**:
  - `mode`: `FIXED | PERCENT | REMAINDER`
  - `scope`: `GLOBAL | CATEGORY | PRODUCT`
  - `priority` ordered
- **Webhook signature verification mandatory**, idempotent payment handling, refunds reverse transfers.
- Until credentials exist, `PAYMENT_DRIVER=mock` simulates the whole flow **including the split breakdown**.
- Razorpay is **ON HOLD**: the live driver needs `PAYMENT_DRIVER=razorpay` **and** `RAZORPAY_ENABLED=true`
  (startup refuses the first without the second). In production the mock refuses every signature
  and checkout offers cash on delivery only (`ONLINE_PAYMENT_UNAVAILABLE`): its signing secrets are
  public constants in this repository, so it cannot vouch for a payment.
- Exact integer splitting lives in `shared/src/money.ts` → `splitPaise()` (no rounding loss).

---

## 10. Env contract

`backend/.env.example` holds **all** keys (local defaults filled, future keys blank):

```dotenv
NODE_ENV=development
APP_NAME=ClearWood Furnitures
API_PORT=7180
API_PREFIX=/api/v1
WEB_ORIGIN=http://localhost:7181
ADMIN_ORIGIN=http://localhost:7182
CORS_ORIGINS=http://localhost:7181,http://localhost:7182
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:./dev.db"
# later: DATABASE_PROVIDER=mysql  DATABASE_URL="mysql://user:pass@host:3306/clearwood"
CACHE_DRIVER=memory
# later: CACHE_DRIVER=redis  REDIS_URL=redis://localhost:6380
REDIS_URL=
JWT_ACCESS_SECRET=dev_access_secret_change_me
JWT_REFRESH_SECRET=dev_refresh_secret_change_me
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
COOKIE_DOMAIN=localhost
STORAGE_DRIVER=local
LOCAL_UPLOAD_DIR=./storage/uploads
PUBLIC_MEDIA_BASE_URL=http://localhost:7180/media
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_PUBLIC_BASE_URL=
MAIL_DRIVER=log
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
MAIL_FROM=no-reply@clearwood.local
PAYMENT_DRIVER=mock
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_ACCOUNT_PRIMARY=
RAZORPAY_ACCOUNT_SECONDARY=
WHATSAPP_NUMBER=919999999999
SUPPORT_PHONE=+91 99999 99999
SUPPORT_EMAIL=care@clearwood.local
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
LOG_LEVEL=debug
# blank => on in development, off everywhere else (Prompt 2 demo catalog)
SEED_DEMO=

# --- auth realms (Prompt 3) ---
ADMIN_JWT_ACCESS_SECRET=dev_admin_access_secret_change_me
ADMIN_JWT_REFRESH_SECRET=dev_admin_refresh_secret_change_me
ADMIN_ACCESS_TOKEN_TTL=15m
ADMIN_REFRESH_TOKEN_TTL=7d
ADMIN_COOKIE_DOMAIN=localhost
CUSTOMER_ACCESS_TOKEN_TTL=15m
CUSTOMER_REFRESH_TOKEN_TTL=30d
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SAMESITE=lax
CSRF_ENABLED=true
PASSWORD_MIN_LENGTH=10
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15
AUTH_RATE_LIMIT_MAX=10
AUTH_RATE_LIMIT_WINDOW_MS=60000
OTP_DRIVER=log
OTP_LENGTH=6
OTP_TTL_SECONDS=300
OTP_RESEND_COOLDOWN_SECONDS=45
OTP_MAX_PER_HOUR=5
OTP_MAX_ATTEMPTS=5
SMS_API_KEY=
SMS_SENDER_ID=
ADMIN_SEED_EMAIL=admin@clearwood.local
ADMIN_SEED_PASSWORD=ChangeMe@12345
ADMIN_SEED_NAME=Platform Owner
```

**Production guard:** startup fails if `NODE_ENV=production` and any JWT/admin secret is still a
dev default, shorter than 32 characters or shared between realms, if `ADMIN_SEED_PASSWORD` or
`ADMIN_SEED_EMAIL` is unchanged, or if `AUTH_COOKIE_SECURE` is not `true`. In every environment it
fails on `PAYMENT_DRIVER=razorpay` without `RAZORPAY_ENABLED=true`. `HOST` (bind address) defaults
to `127.0.0.1` and is passed to `listen`.

**Env validation rule:** keys are required **only when their driver is selected**
(e.g. `S3_BUCKET` is required only if `STORAGE_DRIVER=s3`).
**Blank future keys must NOT block startup.**

Frontends:

- `frontend/web/.env.example` → `VITE_API_BASE_URL=http://localhost:7180/api/v1`,
  `VITE_WHATSAPP_NUMBER`, `VITE_RAZORPAY_KEY_ID=`
- `frontend/admin/.env.example` → `VITE_API_BASE_URL=http://localhost:7180/api/v1`

`process.env` is read in exactly one place: `backend/src/config/env.ts`.

---

## 11. Roadmap

See [ROADMAP.md](./ROADMAP.md). Shipped: **1 — Foundation & config**, **2 — Catalog domain schema,
seed & repository layer**, **3 — Auth, RBAC, sessions & audit**. Current prompt: **4 — Media service**.

### Catalog conventions added in Prompt 2

- `Category.path` is a materialised slug path (`sofas/fabric-sofas`) owned by `CategoryPathService`.
  Depth is capped at **4**; a parent that is already a descendant raises `CATEGORY_CYCLE` (409).
- Category attributes are **inherited down the path**; a row on a child overrides its ancestor's
  flags. Resolution lives in `CategoryAttributeService.resolveForCategory()` and is cached under
  `cat:attrs:{id}`.
- Every catalog write path must call `invalidateCatalogCache(scope)` so R9 keeps holding.
- Rates and percentages are **integer basis points** (18% = 1800), the same discipline D5 applies to
  money.
- The mega-menu, footer and top bar are rows in `NavigationMenu`/`NavigationItem`. Menu items are
  matched on what they point at (category/collection/lead form/url), never on their label, so
  renaming a category cannot duplicate a menu entry.

---

## 12. Auth realms, cookies and permissions (Prompt 3)

**Two INDEPENDENT realms, ONE shared implementation.** Different secrets, audiences and cookie names
mean an admin token can never authenticate a storefront request (and vice-versa), even once the
admin panel moves to `admin.<domain>`. Storage is shared — one `RefreshToken` table with a
`principalType` discriminator — because duplicating rotation and reuse detection would violate
rules 3/5. What stays separate is guards, secrets, cookies and TTLs.

|                           | **ADMIN**                      | **CUSTOMER**                       |
| ------------------------- | ------------------------------ | ---------------------------------- |
| Principal                 | `AdminUser`                    | `Customer`                         |
| Access cookie             | `cw_adm_at` (httpOnly)         | `cw_cus_at` (httpOnly)             |
| Refresh cookie            | `cw_adm_rt` (httpOnly)         | `cw_cus_rt` (httpOnly)             |
| CSRF cookie               | `cw_adm_csrf` (readable)       | `cw_cus_csrf` (readable)           |
| Cookie path               | `/api/v1/admin`                | `/`                                |
| Audience                  | `clearwood-admin`              | `clearwood-web`                    |
| Access TTL                | `ADMIN_ACCESS_TOKEN_TTL` (15m) | `CUSTOMER_ACCESS_TOKEN_TTL` (15m)  |
| Refresh TTL               | `ADMIN_REFRESH_TOKEN_TTL` (7d) | `CUSTOMER_REFRESH_TOKEN_TTL` (30d) |
| Token carries permissions | yes (`perms`)                  | **never**                          |

### Session rules

- **Refresh tokens are cookie-only in the browser.** They are never returned in a response body and
  must never be written to `localStorage`, `sessionStorage`, React state, Zustand state or any other
  browser-readable storage. The **production Admin and Storefront frontends always use
  cookie-based refresh** — `POST …/refresh` with an empty body, the httpOnly cookie _is_ the
  credential.
- `POST …/refresh` accepts a `refreshToken` body field **only** for development/testing clients
  (REST Client, the Vitest suite). That path is rejected outright when `NODE_ENV=production`
  (`REFRESH_TOKEN_IN_BODY_NOT_ALLOWED`) and is never used by a browser.
- Rotation: every refresh issues a new token in the same **family** and marks the old one used.
  Presenting an already-used token revokes the entire family, writes `TOKEN_REUSE_DETECTED` and
  returns `401 TOKEN_REUSE`. Marking it used is an atomic claim (`refreshTokenRepository.claim`):
  two concurrent refreshes with one token cannot both win - the loser is treated as a replay - and
  a revocation that races the winner's insert is re-checked, so a family can never fork.
- Access tokens are signed and verified with **HS256 only** (`algorithms` is pinned on verify). A
  validly signed token whose claims have the wrong shape (`sub`/`sid` strings, integer `ver`) is
  still `TOKEN_INVALID`.
- Only an **ACTIVE** admin holds a usable session: sign-in, refresh and every authenticated request
  refuse DISABLED, SUSPENDED and not-yet-accepted INVITED accounts; a refresh for one also revokes
  its family.
- `mustChangePassword` is **enforced by `authenticate('ADMIN')`**, not by the UI: until it is
  cleared every admin route answers `403 PASSWORD_CHANGE_REQUIRED`, except the self-service routes
  that opt in (`/auth/me`, `/auth/change-password`, `/auth/logout`, `/auth/logout-all`,
  `/auth/sessions`). The new password must differ from the current one and can never be the
  published development placeholder; production also refuses to sign in with that placeholder.
- Invites: an `ADMIN_INVITE` token is redeemed at `POST /admin/auth/reset-password` while the
  account is still INVITED, which sets the password and activates it.
- Access tokens carry `ver` (the admin's `permissionVersion`). Any role or permission change bumps
  it, so live tokens are rejected immediately rather than at expiry.
- CSRF is double-submit: a cookie-authenticated `POST/PUT/PATCH/DELETE` must echo the readable CSRF
  cookie in `X-CSRF-Token`. Only a `Bearer` Authorization header exempts a request, because only
  Bearer replaces the cookie in `authenticate`; any other scheme (say `Basic` credentials a browser
  attaches by itself) leaves the cookie authenticating, so the CSRF header is still required.
  `…/refresh` is deliberately exempt (SameSite=Lax blocks the cross-site POST, the response is
  unreadable cross-origin, and a replayed token kills the family).
- Passwords are **argon2id** (m=19456, t=2, p=1). Failed logins are constant-ish time — a missing
  account still runs a dummy verify — and login/forgot-password responses are byte-identical for
  known and unknown addresses.
- Progressive lockout: `LOGIN_MAX_ATTEMPTS` consecutive failures lock the account for
  `LOGIN_LOCK_MINUTES`; every attempt is written to `LoginAttempt`.

### Permissions

86 codes shaped `group.resource.action`, seeded into the `Permission` table from
`PERMISSION_CODES` in `shared/src/enums.ts`. **Guards reference codes, never role names.**

| Role              | Permissions | Notes                                                                                     |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `SUPER_ADMIN`     | 86          | `isSystem`; also bypasses checks, so new codes work without a re-grant                    |
| `ADMIN`           | 79          | minus `system.role.*`, `system.user.delete`, `payment.*.update`                           |
| `CATALOG_MANAGER` | 36          | `catalog.*`, `pricing.adjustment.*`, `pricing.tax.read`, `media.*`, `cms.navigation.read` |
| `ORDER_MANAGER`   | 15          | orders, customers, refund read/create, product read, inventory                            |
| `CONTENT_MANAGER` | 24          | `cms.*`, `media.*`, `lead.enquiry.*`, catalog reads                                       |

15 codes are marked **dangerous** (`system.role.*`, `system.user.delete`, `payment.*`, `*.export`,
`order.refund.approve`) and raise the audit severity when they are exercised or denied.

Effective permissions are cached under `rbac:perms:{adminUserId}:v{permissionVersion}` (TTL 300 s).
Every role or grant change bumps `permissionVersion` (inside the same transaction for user-role
writes), which moves the key, so one PM2 worker can never serve another worker's stale grants; a
cache error falls back to MySQL.

**No amplification.** `system.user.*` and `system.role.*` let an admin manage what is at or below
their own level and never lift anybody - themselves included - above it. A role may be granted only
if the actor already holds every permission it confers (`403 ROLE_NOT_GRANTABLE`); an account may be
changed only by an actor holding everything it holds (`403 ADMIN_USER_NOT_MANAGEABLE`); a role
definition may be edited, widened or deleted only within the actor's own permissions
(`403 ROLE_NOT_MANAGEABLE`). SUPER_ADMIN is allow-all, so only a SUPER_ADMIN can grant, change or
edit SUPER_ADMIN. Both sides are read from MySQL, never the cache, and every refusal is audited as a
CRITICAL `PERMISSION_DENIED`.

**The last active SUPER_ADMIN** cannot be disabled, suspended, deleted or demoted, by anybody
including themselves (`403 LAST_SUPER_ADMIN`). Every admin-user write runs under
`SELECT ... FOR UPDATE` on the SUPER_ADMIN role row, so two SUPER_ADMINs retiring each other at the
same moment cannot both succeed.

**Bootstrap admin.** The seed creates one account from `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` /
`ADMIN_SEED_NAME` with the ordinary **ADMIN** role and `mustChangePassword=true`, keyed on the email
and never touched again (no password reset, no role re-grant). A fresh install therefore has no
SUPER_ADMIN; there is no API path to one except from a SUPER_ADMIN, so it is provisioned
deliberately, out of band. `npm run admin:reset-password [-- --email <address>]` resets an existing
account to `ADMIN_SEED_PASSWORD`, forces a change at the next sign-in and revokes its sessions.

### Audit

`AuditLog` is the single trail (extended, never forked). Writes are fire-and-forget so an audit
failure can never break a request. `auditService.withAudit()` + `diff()` are what Prompt 5's CRUD
services wrap their writes in; password and secret fields are stripped from every diff.

---

## 13. Media pipeline (Prompt 4)

### Storage keys

Everything that touches bytes goes through `StorageDriver` (`local` today, `s3` from Prompt 17).
Keys are **derived, never taken from the uploaded filename**:

```
{folderPath}/{yyyy}/{mm}/{cuid}-{slugified-basename}[-{label}].{ext}
products/2026/01/clx8s2k10000-teak-sideboard.jpg          ← original
products/2026/01/clx8s2k10000-teak-sideboard-medium.webp  ← rendition
```

- Date partitioning keeps any single directory (or S3 prefix) small.
- The cuid guarantees no collision, so two uploads named `IMG_1234.jpg` never overwrite each other.
- Renditions share the original's prefix, so `keyFamilyPrefix()` + `list()` finds a whole asset
  family for a copy or a delete.
- `normaliseStorageKey()` rejects traversal, null bytes, drive letters, reserved Windows names and
  keys over 900 characters — on **every** driver.
- Private assets are served through `GET /media-signed/*?expires=&signature=`, an HMAC-SHA256
  (base64url, constant-time compare) stand-in for an S3 presigned GET so both drivers behave alike.
  `MEDIA_SIGNING_SECRET` must be changed in production; the app refuses to boot with the default.

### Rendition presets

Defined once in `shared/src/constants.ts` as `RENDITION_PRESETS`. The processor never upscales, so a
small source simply produces fewer renditions. Each preset emits WebP plus the source format (and
AVIF when `ENABLE_AVIF=true`).

| Label   | Longest edge | Fit    | Device target | Typical use            |
| ------- | ------------ | ------ | ------------- | ---------------------- |
| THUMB   | 160          | cover  | ALL           | admin grid, cart line  |
| SMALL   | 320          | inside | ALL           | list rows, swatches    |
| MEDIUM  | 640          | inside | ALL           | product cards          |
| LARGE   | 1024         | inside | ALL           | PDP main image         |
| XLARGE  | 1600         | inside | ALL           | zoom / lightbox        |
| MOBILE  | 750          | inside | MOBILE        | mobile hero            |
| DESKTOP | 1920         | inside | DESKTOP       | desktop hero / banners |
| SQUARE  | 800          | cover  | ALL           | social cards, tiles    |

Originals are auto-rotated from EXIF, downscaled to `MAX_IMAGE_DIMENSION` and stripped of metadata.
Every asset also carries a blurhash, a sub-1.5KB LQIP data URI and a dominant colour, which is what
`frontend/admin/src/lib/mediaSrcSet.ts` (reused by Prompt 13) turns into `srcSet` + a zero-CLS
placeholder.

### Deduplication, usage and deletion

- Uploads are hashed (SHA-256). An identical file returns the existing asset with
  `deduplicated: true` and stores nothing twice.
- The declared `Content-Type` is never trusted: the type is sniffed from the magic bytes. That
  sniffing is hand-rolled in `upload.validator.ts` because `file-type` is ESM-only and the backend
  is CommonJS — add new signatures there rather than pulling the dependency in.
- `MediaUsage` is the single ledger of "where is this asset used", written by
  `mediaUsageService`. Prompts 5, 10, 11 and 15 must attach through it rather than inventing
  their own join table.
- `DELETE /admin/media/:id` is a soft delete (D6). `DELETE /admin/media/:id/permanent` answers
  **409 `MEDIA_IN_USE`** while `usageCount > 0`; `?force=true` detaches everything first and is
  audited as CRITICAL.

### MediaPicker — stable import path

Prompts 5, 10, 11 and 15 all reuse the same asset browser. Import it from exactly:

```ts
import { MediaPicker } from '@/features/media/MediaPicker';
```

Do not move, rename or fork it. New behaviour arrives as optional props
(`multiple`, `kind`, `folderId`, `excludeIds`, `title`) so existing call sites keep working.

---

## 14. Admin catalog contracts (Prompt 5)

### Optimistic locking

Every editable catalog row carries `version Int @default(0)`: `Category`, `Attribute`,
`AttributeValue`, `Product`, `ProductVariant`, `Collection`, `PriceAdjustment`, `Brand`.

- A `PATCH` **must** echo the `version` it loaded. The version is part of the `WHERE` clause
  (`updateMany({ where: { id, version } })`), never a read-then-write check, so two concurrent
  edits can never both land.
- A mismatch is **409 `STALE_RESOURCE`** with
  `details: { entity, id, yourVersion, currentVersion }` — the UI tells the operator to reload.
- The helper is `backend/src/repositories/versioned.ts#updateVersioned`. Use it for every new
  versioned entity rather than incrementing by hand.

### Cache key map

`catalogCache.service.ts` is the only place that knows which prefixes exist. Register new cached
reads there instead of inventing a private key.

| Prefix       | Written by                  | Invalidated by                                 |
| ------------ | --------------------------- | ---------------------------------------------- |
| `cat:tree:`  | `CategoryService.getTree`   | any category create/update/move/reorder/delete |
| `cat:slug:`  | `CategoryService.getBySlug` | the same, plus a slug change                   |
| `cat:attrs:` | `CategoryAttributeService`  | attribute or category-attribute changes        |
| `nav:`       | `NavigationService`         | category and collection changes                |
| `prod:`      | product reads (Prompt 7)    | product, variant, brand and tax class changes  |
| `coll:`      | collection reads (Prompt 7) | collection changes                             |

### DeleteStrategy semantics

`DELETE /admin/catalog/categories/:id?strategy=`

| Strategy            | Behaviour                                                               |
| ------------------- | ----------------------------------------------------------------------- |
| `BLOCK` (default)   | 409 `CATEGORY_IN_USE` while it has any child or product                 |
| `SOFT`              | soft-deletes the node itself (only valid once it is empty)              |
| `REASSIGN_CHILDREN` | children move up to the parent, then the node is soft-deleted           |
| `CASCADE_SOFT`      | the node and every descendant are soft-deleted in one audited operation |

`GET /admin/catalog/categories/:id/delete-impact?strategy=` returns the counts first, so the UI can
warn before anything happens. An `ALL` bucket can never be removed while its parent still holds
products.

### SKU pattern tokens

Used by the variant matrix (`skuPattern`, default `{PRODUCT_SKU}-{INDEX}`):

| Token           | Expands to                                              |
| --------------- | ------------------------------------------------------- |
| `{PRODUCT_SKU}` | the parent product's SKU                                |
| `{ATTR:CODE}`   | the chosen value's code for attribute `CODE`            |
| `{INDEX}`       | the 1-based combination number, zero padded to 2 digits |

The result is upper-cased and de-duplicated; a collision gets a numeric suffix, so a pattern that
is not unique still produces valid SKUs. `pricingMode` is `INHERIT` (variant price stays null) or
`FIXED` (copies the base price) — real per-option pricing is Prompt 6's `PriceAdjustment` work.
The combination count is capped by `VARIANT_MATRIX_MAX` (422 `VARIANT_MATRIX_TOO_LARGE`).

### Inventory is ledger-only

`ProductVariant.stockQty` may only move through `InventoryService`, which writes an
`InventoryLedger` row and the new balance in one transaction.

- The update is a **compare-and-set** on the current balance, so simultaneous adjustments can never
  lose an update; a caller may also pass `expectedBalance` to assert what it saw. Losing writers
  retry, then fail with 409 `INVENTORY_CONFLICT`.
- `stockQty >= 0` and `reservedQty <= stockQty` unless the variant allows backorders
  (409 `INSUFFICIENT_STOCK` / `STOCK_BELOW_RESERVED`).
- `reserve()` / `release()` exist for Prompt 9. `release()` is clamped to the active reservation,
  so replaying it is a harmless no-op and `reservedQty` can never go negative.
- Seeds and CSV imports go through the same service — nothing writes `stockQty` directly.

### Money in CSV

Storage stays Int paise (D5); CSV carries rupees with exactly two decimals so a human can edit it
in a spreadsheet.

- Export: `paise / 100` formatted with `toFixed(2)`.
- Import: thousands separators and a `₹` prefix are accepted (`"12,999.50"` → `1299950`), **three
  or more decimals are rejected** with a row+column error, and rounding is half-up.

### CSV formula injection

A cell whose first character is `=`, `+`, `-`, `@`, a tab or a carriage return is executed as a
formula by Excel, LibreOffice and Sheets. Every exported cell goes through
`escapeCsvValue`, which prefixes those values with a single quote (`'`) before quoting.
`unescapeCsvValue` strips it again on import, so an export → import round trip is lossless.

### Idempotency-Key

Mutations that would duplicate work on a retry — product create, product duplicate, variant matrix
generate, inventory adjust, inventory bulk-adjust, bulk actions, category create and import commit —
accept an optional `Idempotency-Key` header.

- The key is scoped per principal **and** route; the first call runs normally and its response is
  stored until `IDEMPOTENCY_TTL_HOURS` (default 24) elapses.
- A retry with the same key and the same payload replays the stored response verbatim with
  `Idempotent-Replay: true` and never re-executes the handler.
- The same key with a different payload is 409 `IDEMPOTENCY_KEY_REUSED`; a still-running twin waits
  briefly and then answers 409 `IDEMPOTENCY_IN_PROGRESS`.
- Non-2xx responses release the key so the caller can correct the request and retry.

### Import safety

Imports are confined to the catalog: `PRODUCT`, `VARIANT`, `CATEGORY`, `ATTRIBUTE_VALUE`,
`PRICE_ADJUSTMENT` and `INVENTORY`. There is no importable entity that can reach `AdminUser`,
`Role`, `Permission`, `RolePermission` or any other security-domain table.

| Entity             | Required permissions                                      |
| ------------------ | --------------------------------------------------------- |
| `PRODUCT`          | `catalog.product.import`                                  |
| `VARIANT`          | `catalog.product.import` + `catalog.variant.update`       |
| `CATEGORY`         | `catalog.product.import` + `catalog.category.update`      |
| `ATTRIBUTE_VALUE`  | `catalog.product.import` + `catalog.attribute.update`     |
| `PRICE_ADJUSTMENT` | `pricing.adjustment.create` + `pricing.adjustment.update` |
| `INVENTORY`        | `catalog.inventory.update`                                |

A job is validated first (`dryRun`, the default) and only a job that passed may be committed.
Commits run in chunks of `IMPORT_CHUNK_SIZE` inside a transaction, so one bad row rolls back its own
chunk and is reported as `{ row, column, message }` — a half-written product is impossible. Upserts
are keyed on natural business keys (sku / slug / attribute code + value code), so re-running the
same file changes nothing. Imports never publish; status stays `DRAFT`.

### Publish gate

`POST /admin/catalog/products/:id/publish` refuses with 422 `PRODUCT_NOT_PUBLISHABLE` and returns
**every** blocker at once (also persisted to `Product.publishBlockersJson`):

`DUPLICATE_SKU`, `DUPLICATE_SLUG`, `INVALID_PRICE` (zero or negative effective base price),
`NO_PRIMARY_CATEGORY`, `PRIMARY_CATEGORY_UNAVAILABLE` (inactive or deleted),
`NO_TAX_CLASS`, `TAX_CLASS_INACTIVE`, `BRAND_INACTIVE`, `NO_ACTIVE_VARIANT`,
`NO_PRIMARY_MEDIA`, `MEDIA_NOT_READY`, `INVALID_CATEGORY_ATTRIBUTES`.

### Duplicate semantics

`POST /admin/catalog/products/:id/duplicate` copies the business configuration — pricing setup,
dimensions, specs, categories, variants, media links, relations and price rules — and regenerates
every SKU and slug collision-safely (product **and** each variant).

It never copies the original's life in the shop: the copy starts as `DRAFT` with
`publishedAt`, `lastPublishedAt` and `publishBlockersJson` null, and `stockQty`, `reservedQty`,
`soldCount`, `ratingCount` and `ratingAvgBp` all zero. Media assets are shared (same `Media` rows)
but get their own `ProductMedia` and `MediaUsage` rows.

### Slug redirects

Renaming a `Product`, `Category` or `Collection` slug writes a `SlugRedirect` row
(`301` by default). Chains are flattened on write — `A → B` followed by renaming `B → C` repoints
the first row to `C` — so a lookup is always one hop and a rename cycle can never loop.
Prompt 7 serves the redirects.

---

## 15. Pricing engine (Prompt 6)

### The calculation order

Every price in ClearWood is produced by one pure function, `pricingEngine.calculate`. It has no
Prisma import, no cache, and never reads the clock — the caller passes a fully loaded
`PricingContext` and an explicit `now`. That is what makes a quote reproducible: the same context
hash always yields the same number.

The order is fixed. Do not reorder it, and do not add a step without amending this section.

| #   | Step           | What happens                                                                                      |
| --- | -------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Base price     | Variant price if present, otherwise the product's base price.                                     |
| 2   | Price list     | The winning `PriceList` for the customer group/channel replaces the base with its item price.     |
| 3   | Quantity tier  | The winning `TierPrice` replaces (`pricePaise`) or reduces (`discountBp`) the current unit price. |
| 4   | Adjustments    | Matched `PriceAdjustment` rows apply in scope order against their declared basis.                 |
| 5   | Customization  | `customizationAdjustments` supplied by the caller (Prompt 11 fills this).                         |
| 6   | Customer group | The group's `discountBp`, if it has one (applied from engine version 2, Prompt 5; §45).           |
| 7   | Line subtotal  | `unitPrice x qty`. Every component is scaled by qty here.                                         |
| 8   | Discount rules | Active `DiscountRule` rows, evaluated against the whitelisted condition facts.                    |
| 9   | Coupon         | One explicit coupon, or auto-apply coupons; allocated across eligible lines.                      |
| 10  | Shipping       | Zone resolved from the pincode, then the cheapest qualifying rate; free above the threshold.      |
| 11  | Tax            | GST per line from the tax class, split by place of supply; shipping taxed if configured.          |
| 12  | Rounding       | Optional round-to-rupee on the grand total, recorded as its own `ROUNDING` component.             |

### Tier and price-list precedence

- PriceList selection happens **before** TierPrice resolution.
- Within the applicable customer group, the highest `minQty <= qty` wins.
- If that row has `pricePaise`, it **replaces** the unit base used by every later step.
- If that row has `discountBp`, the percentage comes off the current applicable base.
- Tier rows never stack. Exactly one row applies, or none.

### The `PriceBreakdown` contract

`PriceBreakdown` is the only shape any caller — storefront, admin, cart, order — is allowed to
consume. Its invariant is enforced in code by `assertInvariant` and in tests by a 500-iteration
property loop:

```
sum(line.components) === line.totalPaise        for every line
sum(lines.totalPaise) + sum(cart components) === grandTotalPaise
subtotal - discount + shipping + tax + rounding === grandTotalPaise
```

Each `PriceComponent` carries `code`, `label`, `kind`, a signed `amountPaise`, and a
`sourceType`/`sourceId` pair that names the row responsible. Nothing in a breakdown is anonymous;
if the admin simulator cannot explain a number, that is a bug.

### Rounding and allocation

- All money is integer paise (D5). There is no float arithmetic anywhere in the engine.
- Percentages are basis points; `applyBasisPoints` rounds half-up.
- Cart-level amounts (coupons, cart discounts) are spread with `allocateProportionally`, a
  largest-remainder allocation that provably loses zero paise.
- `roundTotalToRupee` adjusts only the grand total, and the delta is surfaced as a `ROUNDING`
  component so the waterfall still sums exactly.

### GST place of supply

The seller state comes from the `pricing.sellerStateCode` setting. The buyer state is derived from
the delivery pincode's shipping zone; if no pincode is known, `defaultPlaceOfSupply` is used and
`placeOfSupply.isFallback` is set to `true`. Same state means CGST + SGST at half the rate each;
different states mean IGST at the full rate. `pricesIncludeTax` flips the engine between
tax-exclusive addition and `taxFromInclusive` extraction.

### Coupon redemption lifecycle

Two-phase, so a coupon can never be over-redeemed by concurrent checkouts:

1. **RESERVE** — a compare-and-set on `Coupon.usedCount` (up to five attempts). Losing the race
   returns `409 COUPON_CONFLICT`; hitting the limit returns `409 COUPON_EXHAUSTED`.
2. **CONFIRM** — idempotent, called after payment succeeds. Confirming a released reservation
   returns `409 REDEMPTION_RELEASED`.
3. **RELEASE** — idempotent, called on failure or abandonment; decrements `usedCount` back.

Prompt 9 drives this from the order flow. Validation failures before reservation are reported as
one of the eleven `COUPON_REJECTION_CODES`, never as a thrown error.

### Cache keys

Pricing reuses the Prompt 5 cache service rather than introducing a second one:

| Prefix         | Holds                                |
| -------------- | ------------------------------------ |
| `price:set:`   | The resolved `PricingSettings` block |
| `price:quote:` | A quote keyed by its context hash    |
| `price:ship:`  | Zone and rate lookups per pincode    |

`invalidatePricing()` clears all three and is called by the price-adjustment, tax-class and pricing
admin services on every write. Entries also expire after `PRICING_CACHE_TTL_SECONDS`.

---

## 16. Storefront catalog and search (Prompt 7)

### The SearchDriver contract

Search sits behind an interface, exactly like cache, storage, mail and OTP:

```ts
indexOne(doc) · indexMany(docs) · remove(entityType, entityId) · clear(entityType?)
search(query): SearchResult · suggest(prefix, limit) · health()
```

`SEARCH_DRIVER=sql` is the shipped implementation. It scans the denormalised `SearchDocument` table
and scores in memory, deliberately avoiding FULLTEXT, `MATCH ... AGAINST` and anything else that
would have to be rewritten when SQLite becomes MySQL 8 (rule D4). The single provider-aware decision
is `candidateLimit()`, isolated in one method and marked with a `// MySQL upgrade:` note.

Relevance is a weighted field score — title 10, sku 9, brand 6, category 5, attributes 4, keywords 4,
body 2 — plus an exact-phrase bonus, a prefix bonus, an all-terms bonus and `popularityScore` as the
tie-break. Admin-managed `SearchSynonym` rows expand the query before scoring; two-way entries map a
synonym back to its term, one-way entries do not.

`meili.search.driver.ts` is a documented stub implementing the same interface. Swapping it in is a
config change plus a reindex — no route, service or test changes.

### The indexing trigger map

Writes emit on one in-process bus (`events/catalogEvents.ts`); cache invalidation and reindexing are
both subscribers, which is what stops them drifting apart.

| Write                                       | Event                | Effect                                                 |
| ------------------------------------------- | -------------------- | ------------------------------------------------------ |
| product create/update/publish/duplicate     | `product.changed`    | reindex that one document                              |
| product unpublish / soft or hard delete     | `product.removed`    | drop that document                                     |
| variant create/update/delete/matrix/reorder | `product.changed`    | reindex the parent product                             |
| inventory adjust                            | `inventory.changed`  | reindex (flips `inStock`)                              |
| price adjustment, tier, price list, group   | `pricing.changed`    | re-price reached products, or one leased rebuild (§45) |
| category write                              | `category.changed`   | reindex categories, drop storefront cache              |
| collection write or evaluation              | `collection.changed` | reindex collections                                    |
| brand write                                 | `brand.changed`      | reindex brands                                         |

A product is indexed for search when it is `status=ACTIVE`, `visibility` is PUBLIC or SEARCH_ONLY and
`publishedAt <= now` (the full visibility rule is §45). `reindexAll` finishes with a prune pass that
removes anything that no longer qualifies.

### The pricingBasis policy

Two different prices are in play on a listing page, and confusing them is how storefronts end up
showing one number while filtering by another. The rule:

- **Filtering and sorting** always use `ProductListingIndex.minPricePaise` (Prompt 4; before that
  `SearchDocument.minPricePaise`): the default audience's price, exact basis in §45.
- **Display** is resolved for the caller's own group, card by card from one pricing context
  (`quoteEach`), so no card's price depends on the others on the page.
- Every list response states which was used in `pricingBasis`: `DEFAULT_GROUP`, or
  `CUSTOMER_GROUP:<code>` whenever the caller's group is not the default group.

The indexed range itself is produced by `pricingFacade.quoteEach` over every active variant, in
`listingIndex.service.ts`, which contains no pricing arithmetic at all — the index agrees with
`/pricing/quote` by construction, not by a second implementation that can drift. Search documents
copy the same numbers.

### The facet counting rule

For each facet dimension, counts are computed with **that dimension's own filters removed** while
every other filter stays applied. Ticking "Beige" therefore does not zero out "Charcoal". Zero-count
values come back with `disabled: true` rather than disappearing, so the panel never reflows under
the pointer. Only attributes that are `isFilterable` _and_ resolvable for the scoped category (via
`categoryAttributeService`) become facets. The price facet is ten equal-width buckets whose counts
sum to the result total.

Since Prompt 4 every count is a SQL aggregate over the grid's own filter (§44): unselected
dimensions share two statements, and each dimension with a selection adds one.

### The collection rule DSL

Prompt 5 validated and stored `rulesJson`; Prompt 7 evaluates it. The tree is **compiled to a Prisma
`where` object** — no `eval`, no string concatenation, no raw SQL.

- Fields: `COLLECTION_RULE_FIELDS` — categoryId, categoryPath, brandId, taxClassId, basePricePaise,
  compareAtPricePaise, attributeValueId, productType, searchKeywords, createdAt, isFeatured,
  isNewArrival, isBestSeller, isSpecialCollection, isMadeToOrder, soldCount, ratingAvgBp, tags,
  stockStatus.
- Operators: `COLLECTION_RULE_OPERATORS` — EQUALS, NOT_EQUALS, GREATER_THAN, GREATER_OR_EQUAL,
  LESS_THAN, LESS_OR_EQUAL, BETWEEN, CONTAINS, STARTS_WITH, IN, NOT_IN.
- Shape: `{ match: ALL|ANY, groups: [{ match, rules: [{ field, operator, value }] }], limit? }`.

Anything outside those lists is rejected by Zod at the boundary and again by the compiler.
`evaluate()` materialises `CollectionProduct` in one transaction and **preserves manual position
overrides** for products that still match. MANUAL collections are never touched.

### Slug redirects

`GET /catalog/resolve?path=` answers `PRODUCT`, `CATEGORY`, `COLLECTION`, `REDIRECT` or `NOT_FOUND`.
Chains were already flattened on write in Prompt 5, so a lookup is one hop; a loop guard caps it at
three anyway. `hitCount` is incremented fire-and-forget — a redirect must answer even if the counter
write loses a race.

### Cache keys

| Prefix      | Holds                                                            |
| ----------- | ---------------------------------------------------------------- |
| `sf:set:`   | Storefront settings: page sizes, popularity weights              |
| `sf:list:`  | Grids (`grid:<customer\|anon>:`) and landings by full query hash |
| `sf:facet:` | Facet counts by scope + filter hash                              |
| `sf:pdp:`   | Assembled product detail payloads                                |
| `sf:sugg:`  | Autocomplete results (60 s)                                      |
| `sf:view:`  | Per-session view dedupe windows                                  |

`catalogCacheService.invalidateStorefront()` drops the first four and runs inside every existing
catalog and pricing invalidator, so an admin edit is visible on the very next public request.
Cacheable GETs also carry an `ETag` and honour `If-None-Match` with a 304.

---

## 17. Cart, wishlist and addresses (Prompt 8)

### The lineKey formula

A cart line is identified by a deterministic key, never by a row id:

```
lineKey = sha256(productId | variantId ?? '' | sortedOptionValueIds | customizationHash ?? '')
```

Sorting the option ids is what makes it stable — the same configuration arriving with its attributes
in a different order lands on the same line. `(cartId, lineKey)` is UNIQUE, so re-adding a
configuration increments the quantity instead of creating a twin row, and ten parallel identical
adds collapse to one line of quantity ten. The trailing customization segment is reserved for
Prompt 11, so adding a configurator changes neither the formula nor the schema.

### The cart cookie contract

| Property   | Value                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Name       | `cw_cart` (`CART_COOKIE_NAME`)                                              |
| Payload    | `<sessionId>.<expiresAtMs>.<hmac-sha256>` signed with `CART_COOKIE_SECRET`  |
| Session id | 128 bits from `randomBytes` — never a timestamp, a counter or a customer id |
| Flags      | httpOnly, `sameSite=lax`, `secure` in production, TTL `CART_GUEST_TTL_DAYS` |

Rules that matter:

- **A read never mints a cookie.** `GET /cart` on an empty cart sets nothing; only a write that
  actually persists a guest cart calls `persist()`.
- The signature is verified with `timingSafeEqual`, so a forged cookie cannot be brute-forced a byte
  at a time.
- A tampered, malformed or expired cookie is indistinguishable from no cookie: the shopper silently
  gets a fresh cart. It is never a 500, and it never explains why it failed.
- Nothing in `cartIdentity.ts` is logged. The raw cookie and the secret must not reach a log line.
- A signed-in customer always wins over the cookie — their cart follows the account, not the browser.

**One ACTIVE cart per owner is a database guarantee, not a hope.** `Cart.activeOwnerKey` is
`c:<customerId>` or `s:<sessionId>` while ACTIVE and NULL otherwise, with a UNIQUE index on it.
NULLs are never compared, so any number of finished carts can coexist, and the constraint is
portable to MySQL 8, which has no partial indexes. `getOrCreate` retries on P2002 rather than
locking.

### Merge rules

Merging happens on the SERVER, inside the existing `customer-auth.service` login / OTP-verify /
register success paths. There is no second auth flow and no client-driven merge in the happy path.

| Situation                         | Outcome                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| Line exists on both carts         | Quantities summed (`SUM_QUANTITIES`), then clamped and reported |
| Clamped by stock or max-order-qty | Reported in `clamped[]` with the requested and final quantity   |
| Product now unavailable           | Skipped, with a reason in `skipped[]`                           |
| Both carts have a coupon          | Customer's is kept, then re-validated against the merged cart   |
| Coupon no longer valid            | Dropped, with `couponOutcome` and `couponReason` saying so      |
| Guest cart afterwards             | `status=MERGED`, `mergedIntoCartId` set — **never deleted**     |
| Run twice                         | Second call answers `merged: false` and changes nothing         |

Wishlists and recently-viewed rows follow the same session id into the account.

### The cart never stores authoritative money

`cartPricing.service.ts` has no arithmetic in it — not a sum, not a multiplication. It turns a cart
into a `QuoteInput`, hands it to the Prompt 6 engine and returns the resulting `PriceBreakdown`
untouched. That is why a cart response and `/pricing/quote` agree on `subtotalPaise`,
`discountPaise`, `shippingPaise`, `taxPaise`, `roundingPaise` **and** `grandTotalPaise`, rather than
merely on the total.

The `addedUnitPricePaise` / `lastUnitPricePaise` columns on a line are historical snapshots used for
exactly one thing: detecting drift. When a snapshot and the live price disagree, the difference
surfaces in `priceChanges[]` instead of being quietly papered over. Nothing displayed is ever
derived from a snapshot.

**The cart also never reserves stock.** `cartValidation.service` reads `stockQty - reservedQty` to
report availability; reservation belongs to Prompt 9's checkout.

### Validation codes

| Code                    | Severity | Meaning                                           |
| ----------------------- | -------- | ------------------------------------------------- |
| `OK`                    | INFO     | Nothing wrong with this line                      |
| `OUT_OF_STOCK`          | BLOCKING | Nothing left to sell                              |
| `INSUFFICIENT_STOCK`    | BLOCKING | Fewer units available than requested              |
| `ABOVE_MAX_QTY`         | BLOCKING | Above the per-line or per-product ceiling         |
| `BELOW_MIN_QTY`         | BLOCKING | Under the product's minimum order quantity        |
| `UNAVAILABLE`           | BLOCKING | Unpublished, archived, soft-deleted or no variant |
| `NOT_SERVICEABLE`       | BLOCKING | No shipping zone covers the cart's pincode        |
| `BELOW_MIN_ORDER_VALUE` | BLOCKING | Under the store's minimum order value             |
| `TOO_MANY_LINES`        | BLOCKING | Above `CART_MAX_LINES`                            |
| `PRICE_CHANGED`         | WARNING  | The live price moved since the line was added     |
| `MADE_TO_ORDER`         | INFO     | Built to order — ships after its lead time        |
| `COUPON_INVALID`        | WARNING  | The coupon stopped applying after a cart change   |

`POST /cart/validate?autoFix=true` clamps what it can and reports every change in `fixes[]`. It
never silently removes a line.

### New cache keys

| Prefix      | Holds                                     |
| ----------- | ----------------------------------------- |
| `addr:pin:` | Pincode autofill + serviceability lookups |

Carts are deliberately absent from the cache. A cart is per-shopper, mutable and money-bearing, so
it is always read live and re-quoted. `invalidatePricing()` drops `addr:pin:` too, so editing a
shipping zone cannot leave a stale delivery promise on an address form.

---

## 18. Orders, payments and the Route split (Prompt 9A)

### The five laws

| #      | Law                                    | How it is enforced                                                                                                                                    |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | The client never sends an amount       | `placeOrderSchema` is `.strict()` — a body containing `amountPaise` is a 422, not a silent ignore. Every paise is recomputed server-side at placement |
| **L2** | An order is immutable money            | The whole `PriceBreakdown` is frozen into `breakdownJson` plus per-line `componentsJson`; reads replay the snapshot and never re-quote                |
| **L3** | The webhook is the source of truth     | The browser's verify call and the webhook funnel into one idempotent `confirmPayment`; every event is persisted before it is acted on                 |
| **L4** | Money movement is double-entry         | Order → Payment → PaymentTransfer → Settlement, Refund → TransferReversal, with `ledgerIntegrity.verifyOrder()` asserting it balances                 |
| **L5** | Nothing is held without a release path | Every `StockReservation` has an expiry and an owner; `releaseHolds()` is the single exit, driven by failure, abandonment, cancellation and the sweep  |

### The order state machine

`orderStateMachine.transition()` is the ONLY way an order's status changes. It validates the edge,
runs the guard, writes `OrderStatusHistory`, emits an event and audits — so there is one place that
decides what is legal and no way for a new caller to bypass it.

| From                                 | May become                                                             |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `DRAFT`                              | PENDING_PAYMENT · CONFIRMED · CANCELLED · EXPIRED                      |
| `PENDING_PAYMENT`                    | CONFIRMED · PAYMENT_FAILED · CANCELLED · EXPIRED                       |
| `PAYMENT_FAILED`                     | PENDING_PAYMENT · CONFIRMED · CANCELLED · EXPIRED                      |
| `CONFIRMED`                          | PROCESSING · READY_TO_SHIP · CANCELLED · REFUNDED · PARTIALLY_REFUNDED |
| `PROCESSING`                         | READY_TO_SHIP · CANCELLED · REFUNDED · PARTIALLY_REFUNDED              |
| `READY_TO_SHIP`                      | SHIPPED · CANCELLED · REFUNDED · PARTIALLY_REFUNDED                    |
| `SHIPPED`                            | OUT_FOR_DELIVERY · DELIVERED · RETURN_REQUESTED · PARTIALLY_REFUNDED   |
| `OUT_FOR_DELIVERY`                   | DELIVERED · RETURN_REQUESTED                                           |
| `DELIVERED`                          | RETURN_REQUESTED · PARTIALLY_REFUNDED · REFUNDED                       |
| `RETURN_REQUESTED`                   | RETURNED · DELIVERED                                                   |
| `RETURNED`                           | REFUNDED · PARTIALLY_REFUNDED                                          |
| `PARTIALLY_REFUNDED`                 | REFUNDED                                                               |
| `CANCELLED` · `REFUNDED` · `EXPIRED` | _terminal_                                                             |

**Guards.** `CONFIRMED` requires `paymentStatus=CAPTURED`, or a zero-total order, or an explicit
`unpaidConfirmation` — which only the COD path sets. `REFUNDED` requires something to have been
paid. An illegal edge is a 409 `INVALID_ORDER_TRANSITION` that lists the allowed targets.

9A drives DRAFT → PENDING_PAYMENT → CONFIRMED / PAYMENT_FAILED / EXPIRED / CANCELLED. The fulfilment
edges exist now so 9B only has to call the same function.

### Order numbers

`CW/{FY}/{000001}` — the Indian financial year (April to March), because that is the boundary every
GST return and auditor works to. Allocation is a compare-and-set on `OrderSequence.lastNumber` with
a jittered retry, the same pattern inventory uses, so concurrent checkouts cannot collide and there
is no lock to port to MySQL.

### The split algorithm

`split.engine.ts` is PURE — no Prisma, no clock, no I/O.

1. Rules are filtered by `minOrderPaise` and by whether their recipient account is active, then
   ordered by **priority asc, then specificity** (GLOBAL < BRAND < COLLECTION < CATEGORY < PRODUCT),
   then id.
2. A scoped rule matches a line by product, brand, collection, or **category including ancestors**
   (the Prompt 2 materialised path), so a rule on "Sofas" also matches a "Fabric Sofas" line.
3. Each non-REMAINDER rule takes its amount from its basis: FIXED takes `valuePaise`, PERCENT takes
   `valueBp/10000` of `ORDER_TOTAL`, `ORDER_SUBTOTAL`, `LINE_TOTAL` or `LINE_SUBTOTAL`.
4. Each allocation is clamped to `maxTransferPaise` and to whatever is left. It can never go
   negative and never exceeds the remaining amount; every clamp is recorded in the row's `note`.
5. The single REMAINDER rule — or the primary account by default — receives the residue.
6. **The final amounts are produced by `shared/money.splitPaise`**, the same largest-remainder
   helper the money tests already pin, so `sum(allocations) === transferablePaise` exactly. A
   mismatch throws `SPLIT_INVARIANT_VIOLATION` rather than shipping money to nowhere.
7. Zero-value allocations are PERSISTED for audit but never sent to a provider, which rejects them.

**The canonical case:** a ₹6,000 order with a FIXED ₹1,000 rule to PARTNER_A and a REMAINDER rule to
PRIMARY allocates exactly `[PARTNER_A 100000, PRIMARY 500000]`.

**Allocations are written BEFORE the provider is called**, so the payout intent survives a failed
transfer request. **A failed transfer never rolls back a capture** — the customer's money arrived;
the transfer is marked FAILED, the order stays CONFIRMED, and `/admin/orders/:id/retry-transfers`
repairs it. COD creates allocations for reporting but no transfers.

### The webhook contract

`POST /api/v1/webhooks/razorpay`, mounted with `express.raw` **before** the JSON parser because the
HMAC is computed over the exact bytes the provider sent.

1. **Verify, then parse.** An unsigned or wrongly-signed body is a 400 and is NOT persisted —
   storing it would hand an attacker a free write.
2. **Persist, then act.** A `WebhookEvent` row is written first, so an event that crashes mid-flight
   is still on record and replayable from the admin.
3. **Once, and only once.** `@@unique([provider, providerEventId])` plus a compare-and-set
   `processingLockedAt` lock: five simultaneous deliveries produce one state change and four
   `DUPLICATE` rows.
4. **Out of order is fine.** A capture arriving before the verify call confirms the order on its
   own; a stale event for an order that has already moved on is IGNORED, not an error.
5. **Always 200 for a validly signed event.** Razorpay retries anything non-2xx, and a bug in our
   handler must not become a retry storm. A failure is surfaced as `status=FAILED` with an attempt
   count and replayed deliberately — which is visible and controllable in a way a provider's retry
   schedule is not.

Handled: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
`refund.created/processed/failed`, `transfer.processed/failed`, `settlement.processed`.

### The reservation lifecycle

**The cart never reserves stock. Checkout does.**

```
place  → inventory.service.reserve()  + StockReservation RESERVED (expiresAt = now + CHECKOUT_HOLD_MINUTES)
capture→ inventory.service.release() + inventory.service.adjust(-qty, ORDER_FULFILLED) + CONSUMED
fail   → inventory.service.release() + RELEASED
expire → inventory.service.release() + EXPIRED   (the sweep)
```

`inventory.service` remains the only thing that writes `stockQty` or `InventoryLedger`; the
`StockReservation` row exists so the sweep knows exactly what to hand back. Settling is a
compare-and-set on the row's status, so releasing twice returns the units exactly once. Coupons
follow the same two-phase shape through the Prompt 6 `coupon.redemption.service`.

### Redaction rules

`redactProviderPayload()` in `drivers/payment/payment.driver.ts` is the single gate. Anything stored
in `Payment.rawResponseJson`, `PaymentTransfer.rawResponseJson` or `WebhookEvent.payloadJson` passes
through it first.

- Replaced with `[REDACTED]`: `key_secret`, `secret`, `password`, `token`, `authorization`,
  `card_number`, `number`, `cvv`, `expiry_month`, `expiry_year`, `pin`, `signature`,
  `webhook_secret`.
- Kept: `last4` — it is what lets support say "the card ending 4242" without holding a card number.
- The Razorpay key secret is used to build an `Authorization` header and to sign; it is never
  logged, never placed in an error body and never stored. A test scans every stored payload for it.

### New cache keys

None. Orders and payments are never cached: they are money, they change under you, and a stale
answer about what somebody paid is worse than a slow one.

---

## 19. Fulfilment, shipping and returns (Prompt 9B)

### Verified vs unverified provider paths � READ THIS BEFORE GO-LIVE

| Driver | Status | Notes |
| --- | --- | --- |
| `manual` | **VERIFIED** | Admin-driven fulfilment. The default, and what a furniture business actually starts with: a sofa goes on our own truck, an admin drives the status. |
| `mock` | **VERIFIED** | A complete offline courier simulator used by the tests: couriers, AWB, pickups, timelines, NDR, RTO, cancellation, and injectable failures. |
| `shiprocket` | **UNVERIFIED � DO NOT SHIP REAL ORDERS THROUGH IT** | See `backend/src/drivers/shipping/shiprocket.shipping.driver.UNVERIFIED.ts`. |

**No live Shiprocket account has ever existed for this project and no live call has ever been
made.** The Shiprocket client was written from published documentation. That makes its
authentication scheme, its webhook body shape and its `x-api-key` header convention documented
facts � but **the endpoint paths in its `PATHS` map are convention and are unverified**, as are the
response field names each parser reads. No test in this repository can catch a wrong path, because
every test runs against the mock.

The file is named `.UNVERIFIED.ts` on purpose. Unverified integration code is more dangerous than
absent integration code: it looks finished, so nobody re-checks it before go-live.

`SHIPPING_DRIVER` defaults to `manual`. Shiprocket is **ON HOLD**: it is used only with
`SHIPROCKET_ENABLED=true`, its three credentials and, in production, `SHIPPING_PROVIDER_VERIFIED=true`.
Anything less falls back to `manual` with a startup WARN - a half-configured courier never stops the
API from booting - and a Shiprocket provider row switched on in the admin is refused with
`SHIPPING_PROVIDER_DISABLED`.

### Prompt 17 go-live checklist � shipping

- [ ] Create a Shiprocket API user (Settings ? API ? Add New API User).
- [ ] Validate **every** path in `PATHS` against the sandbox; correct them in that one map.
- [ ] Confirm the response field names each parser reads.
- [ ] Run one real end-to-end shipment: create ? AWB ? pickup ? track ? cancel.
- [ ] Confirm a real webhook is received, verified and applied.
- [ ] Only then set `SHIPPING_PROVIDER_VERIFIED=true` and `SHIPROCKET_ENABLED=true`.

### One webhook inbox, not two

Courier events reuse the Prompt 9A `WebhookEvent` table with `provider = "shipping:{CODE}"`. One
inbox, one replay mechanism, one place an admin looks when something is wrong. The same three rules
apply: verify before parsing, persist before acting, process once under a compare-and-set lock.

### A timed-out shipping call is never retried blindly

Every mutating provider call first claims a deterministic key in `ProviderOperation`. A duplicate
key means *already attempted*, so the call is refused and reconciliation is demanded instead. A
duplicate charge can be refunded; a duplicate wardrobe on a lorry cannot.

### Unrecognised courier statuses change nothing

`mapProviderStatus()` returns null for anything it does not recognise, and the shipment is left
where it is with the raw status recorded. Guessing a parcel forward is how a customer gets told
their sofa was delivered to an empty house.

---

## 20. Refund execution hardening (9B addendum H0-H6)

Refund execution is the most dangerous code in the project: it moves real money, it is reachable
from several places at once, and its failures are silent. These are the decisions that keep it safe,
and the reasoning behind each - because the reasoning is what stops someone "simplifying" them later.

### H1 - the execution lock lives in the database, not the process

`Refund.executionLockedAt` plus a conditional `updateMany` is the only thing that decides who
executes a refund. **Prompt 17 runs PM2 with several workers**, so a process-local mutex or an
in-memory Set protects nothing: each worker would hold its own and both would call the provider.
A stale lock older than `REFUND_LOCK_TIMEOUT_MINUTES` may be reclaimed **only** by
`reconciliation.verifyPendingRefunds()` - never by a user action, because a human cannot tell a dead
worker from a slow one.

### H2 - the over-refund guard is part of the write

Every money increment carries its own predicate:

| Write | Predicate |
| --- | --- |
| `Order.refundedPaise` | `refundedPaise <= paidPaise - amount` |
| `PaymentTransfer.reversedPaise` | `reversedPaise <= amountPaise - amount` |

Read-then-write cannot work here: between the read and the write, another worker refunds. Five
parallel 40% refunds against one order produce exactly two successes and three rejections, and the
ledger still balances - that is a test, not an aspiration.

### H3 - deterministic reference, and intent recorded before the call

`Refund.clientReference` is sent to the provider and is unique. Before any provider call we persist
and commit the intent (`PROCESSING`, plus `TransferReversal` rows as `PENDING`). On retry we
**always** ask `fetchRefundsForPayment()` and adopt a refund carrying our reference rather than
creating a second one.

### H4 - a timeout is UNKNOWN, not FAILED

This is the distinction the whole design turns on. `classifyProviderError` returns:

- **TERMINAL** - the provider read it and said no. Nothing moved. -> `FAILED`.
- **RETRYABLE** - it demonstrably never landed. -> `FAILED`, safe to retry.
- **UNKNOWN** - timeout, reset, ambiguous body. It may well have succeeded. -> `PENDING_VERIFICATION`.

The default is UNKNOWN, deliberately. A `PENDING_VERIFICATION` refund cannot be executed, approved
or edited from any route (403 `REFUND_AWAITING_VERIFICATION`); only reconciliation resolves it, by
asking the provider. Marking a timeout as FAILED is how a customer gets refunded twice.

### H5 - exactly one side reverses

`capabilities().reversesTransfersWithRefund` makes this a single explicit decision. If the provider
reverses linked-account transfers as part of the refund, we record what it did and call
`reverseTransfer` for nothing; otherwise we plan and issue them ourselves. Doing both double-counts.
Razorpay advertises `false` here on purpose: we reverse explicitly so every reversal is recorded
against the transfer it undoes and the ledger can be verified.

The reversal write is one transaction - predicate and row update together. They were briefly
separate, and the ledger immediately caught a transfer incremented with no PROCESSED row behind it.

### H6 - what the ledger now asserts

Added to `verifyOrder`: processed refunds equal `Order.refundedPaise`; per-transfer reversals equal
`reversedPaise` and never exceed `amountPaise`; a refund never reverses more than its own value;
total reversed never exceeds total transferred; and nothing sits in `PROCESSING` or
`PENDING_VERIFICATION` past the lock timeout without appearing in the needs-attention queue at
`GET /api/v1/admin/payments/attention`.

**A pre-existing check was wrong.** `paid_equals_captured_minus_refunded` asserted
`paidPaise === captured - refunded`, which only ever passed because Prompt 9A could never process a
refund. Refunds accumulate in `refundedPaise` and do not reduce `paidPaise`, so it is now
`paid_equals_captured` plus `refunded_within_paid`.

### H0 - the repository refuses secrets

`scripts/check-secrets.mjs` runs in the test suite (against `git ls-files`) and as
`npm run check:secrets:staged` for a pre-commit hook. `.gitignore` only protects files nobody has
added yet; `git add -f` walks straight past it, and a real `.env` committed once is in the history
forever.

### H7 - refund capacity is RESERVED, not checked

`Order.refundReservedPaise` and `PaymentTransfer.reversalReservedPaise` hold capacity across the
provider call, using the same reserve/confirm/release shape `StockReservation` and
`CouponRedemption` already use. Nothing new was invented, because the problem is not new: it is two
shoppers racing for the last sofa, with money instead of stock.

**Why a check cannot work.** A check answers *"is there room right now"*. By the time the provider
replies - seconds later, over a network - another worker may have taken that room. A reservation
answers *"the room is mine"*, and holds it for the duration of the call. That is the entire
difference between two concurrent refunds both seeing the same money as available and only one
getting it.

**A remote system''s validation may never enforce a local invariant.** Razorpay rejecting an
over-refund is a happy accident, not a guarantee: it can be relaxed, versioned, or simply absent on
another provider. The mock therefore has `setPermissiveRefunds(true)`, and a test proves that five
parallel 40% refunds still succeed exactly twice against a provider that would have allowed all
five. The provider''s own check remains only as defence in depth.

**Sequence.** Reserve (predicated, all-or-nothing, committed) -> provider call -> then:

| Outcome | Action |
| --- | --- |
| success | confirm: `refundReservedPaise -= amount`, `refundedPaise += amount` |
| TERMINAL | release - the provider read it and said no |
| RETRYABLE | release - it demonstrably never landed |
| **UNKNOWN** | **HOLD** |

**Why UNKNOWN holds.** Releasing capacity for a refund that may have succeeded lets a second refund
through; if the first one did land, the customer is paid twice. Holding costs nothing but a
temporarily lower ceiling. This mirrors the stale-lock rule exactly: only `reconciliation`, having
asked the provider what actually happened, may convert a hold into confirmed or released. No route,
no admin button, no retry.

The ceiling is reservation-aware everywhere - `refundCalculator.maxRefundablePaise` subtracts
reserved capacity, so a refund that could never execute cannot even be *requested*.

Ledger additions: `refundedPaise + refundReservedPaise <= paidPaise`;
`reversedPaise + reversalReservedPaise <= amountPaise` per transfer; and a non-zero reservation must
belong to a refund in `PROCESSING` or `PENDING_VERIFICATION` - capacity held by nothing is capacity
nobody will ever release.

---

## 21. Guardrails added before Prompt 9B item 6

### OpenAPI documentation debt (owner: Prompt 15/16)

`api.test.ts` asserts that **every mounted Express route is either documented or listed in
`docs/openapi-debt.json`**. The debt file starts at **176 routes** inherited from Prompts 1-8 and
**may only shrink**: adding an entry fails the test, and `DEBT_CEILING` in `api.test.ts` is the
ratchet.

The old check asserted only that the 119 documented paths *exist*. It said nothing about the 176
mounted routes that were never documented, which is exactly how they accumulated unnoticed.

The route list is read from the **live Express router stack**, not from the route files, so a route
that is written but never mounted does not count as covered.

Mostly `admin/catalog` (70) and `admin/pricing` (42). Everything from item 9 onward documents
itself; the backlog is burned down in Prompt 15/16.

### The UNVERIFIED quarantine is now enforced by eslint

`no-restricted-imports` forbids importing `*.UNVERIFIED.*` anywhere except
`drivers/shipping/index.ts`, the factory. The env gate stopped production *booting* on the
unverified Shiprocket client; nothing stopped a developer importing the class directly.

### `stockQty` has exactly one writer, enforced

`scripts/check-stock-writes.mjs` (`npm run check:stock`, also asserted in `repo-hygiene.test.ts`)
fails if `stockQty` appears in a Prisma `data:` payload outside `inventory.service.ts`. Creating a
variant at `stockQty: 0` is exempt: that is an opening balance, not a movement.

Tests now set stock through `tests/helpers/stock.ts`, which calls `inventoryService.adjust`. The
scaffolding therefore exercises the same compare-and-set production uses and leaves real
`InventoryLedger` history. It previously wrote `stockQty` directly with a comment claiming that was
fine � the guard found two more instances than the audit had spotted by eye.

### Stale TODOs removed

`collection.admin.service.ts` carried `TODO(Prompt 7): evaluate rulesJson`. Prompt 7 shipped
`storefront/collectionRules.service.ts`, which compiles the rule tree to a Prisma filter and is
mounted on three admin routes. The comment was stale; there is **one** evaluator and the admin
preview and storefront listing share it. `catalog.routes.ts` carried three similarly stale TODOs for
Prompts 5, 6 and 7.

---

## 22. Returns are an admin-operated process (scope decision)

**Customer-initiated returns are FROZEN behind `FEATURE_CUSTOMER_RETURNS`, default `false`.**

A customer asks for a return by phone or WhatsApp, and an admin raises it in the console. That is
how a furniture business with a handful of returns a week actually works: each one needs a
conversation about collection, and a self-service form would mostly generate requests somebody has
to ring back about anyway.

Nothing was deleted. The full return service, its state machine, the RESELLABLE-only restock rule,
the ledger checks and all 16 tests remain exactly as built � they are correct and are exercised by
the admin path every test run.

### What the flag does

| Surface | Behaviour |
| --- | --- |
| `GET/POST /api/v1/me/orders/{orderNumber}/returns`, `/returnable` | **404** while the flag is off |
| `/api/v1/me/orders/{orderNumber}/shipments` | unaffected � tracking is not a return |
| All `/api/v1/admin/returns/*` | unaffected, always enabled |

**404 and not 403, deliberately.** A 403 says "this exists and you may not have it", which is untrue
and invites support tickets. The feature does not exist for customers yet.

### What is NOT built, by decision

No customer return-request UI, no return policy pages, no return-specific notification templates
(the enum values exist; no templates reference them), no dedicated `/returns` or `/refunds` admin
pages. Refunds are reachable from the order detail page as an admin action � there is no separate
queue, because the queue would be a list of one.

Turning the flag on needs a customer-facing UI and the return notification templates; neither is in
scope for Prompt 9B.

## 23. Standing rule G1 - no tautological assertions

**Any assertion of equality, determinism, checksum match, or "no differences" must be paired with an
assertion that the compared value is non-trivial.**

An empty set equals an empty set. Two zero-byte buffers are byte-identical. The SHA-256 of nothing
matches the SHA-256 of nothing. A test that only proves `a === b` proves nothing when both sides can
be empty, and it will keep passing after the thing it guards has stopped working.

This rule exists because it has already failed twice in this codebase:

- The PDF renderer returned zero bytes because PDFKit flushes asynchronously and `doc.end()` only
  starts the write. The determinism test compared two empty buffers and printed "DETERMINISTIC
  true".
- The OpenAPI test asserted that 119 documented paths existed while 176 mounted routes were
  undocumented. The filtered list came out empty because the comparison was against the wrong set.

### What it requires

| Assertion | Must also assert |
| --- | --- |
| Byte or buffer comparison | minimum size, and the expected leading marker (e.g. `%PDF-`) |
| Checksum equality | the checksum is not the hash of empty input |
| "set A equals set B" | A is non-empty |
| "no drift after a re-run" | the counted collection has rows |
| "no failing checks" | checks actually ran, and the expected ones by name |
| A reconciled figure matches | the figure is non-zero |

Asserting a *specific* emptiness is not a tautology and needs nothing extra: a cleared cart is
genuinely empty, a leaf category genuinely has no children, and a refund with nothing to reverse
genuinely produces no reversals. The rule targets assertions where emptiness is an accident rather
than the point.

### Enforcement

Ledger assertions go through `backend/tests/helpers/ledger.ts`, which asserts both "nothing failed"
and "something ran" in one call, so the vacuous form is not reachable by copy-paste:

```ts
expectLedgerOk(report, { minChecks: 10, mustInclude: ['invoice_total_matches_order'] });
```

## 24. Notifications (9B slice C)

**A notification is a consequence of a business event, never a participant in it.**

`notificationService.dispatch()` cannot throw into a caller. If the mail server is down the order
was still placed and paid for; failing the request would leave the customer charged and looking at
an error, and rolling back would be worse. This is asserted, not asserted-in-a-comment: a test
forces the mail driver to reject during a real paid checkout and then verifies the order is
`CONFIRMED`, `paidPaise` is intact, and the failure is recorded.

Every attempt writes a `NotificationLog` row - `SENT`, `FAILED` or `SKIPPED`. Silence is the one
outcome that is not allowed, because "we never told the customer" has to be answerable afterwards.

### The eight templated events

`ORDER_PLACED`, `ORDER_CONFIRMED`, `PAYMENT_FAILED`, `ORDER_SHIPPED`, `OUT_FOR_DELIVERY`,
`ORDER_DELIVERED`, `ORDER_CANCELLED`, `INVOICE_ISSUED`. The remaining `NOTIFICATION_EVENTS` values
are raised internally and deliberately have no template: nobody needs an email because an AWB was
allocated. There are **no return templates** while customer returns are frozen (section 22).

`SHIPPED`/`DELIVERED`/`INVOICE_READY` were renamed to `ORDER_SHIPPED`/`ORDER_DELIVERED`/
`INVOICE_ISSUED` so the enum reads as one lifecycle. The values were only ever referenced as
`z.enum(NOTIFICATION_EVENTS)`, so nothing else moved.

The shipment events are driven off the **derived order status** in `shipmentService.syncOrderStatus`,
not off individual shipments, so a three-parcel order gets one "delivered" email when the last box
lands rather than three.

### Interpolation is a key lookup, nothing more

Templates are admin-editable, which makes the substitution engine security surface. `{{token}}`
accepts `[a-zA-Z0-9_]` only - it cannot express a property path - and resolves against a flat
`Record<string, string>` using `Object.hasOwn`. There is no `eval`, no `new Function`, no property
traversal. `{{constructor}}`, `{{__proto__}}` and `{{order.customer.email}}` are all just unknown
tokens.

Unknown tokens behave differently by environment, on purpose:

| Environment | Behaviour | Why |
| --- | --- | --- |
| test / dev | **throws** `NOTIFICATION_UNKNOWN_TOKEN` | a typo is a defect and must stop the build |
| production | renders `''` | a typo must not take down order confirmation emails |

The dispatch catch-all re-throws that one error outside production, otherwise a template defect
would be swallowed into a log line and the "fails loudly" rule would be theatre. A test renders
every seeded template against a real order's context to catch typos at source.

### Recipients are masked at write time

`ravi.kumar@example.com` is stored as `ra***@example.com`; `+919876543210` as `+91******3210`.
Masking on display would leave plaintext in the table, and the table is what ends up in a backup, a
support export or a screenshot in a ticket. The mask is lossy and irreversible: enough to recognise
an address you already know, not enough to contact anybody.

### Routes

`GET/PUT /admin/notifications/templates`, `GET /admin/notifications/logs`. There is deliberately
**no send route** - a button that emails "your order has shipped" when it has not is a way to lie
to a customer from the console - and **no log delete**, because the log is the evidence.

## 25. Reports (9B slice D)

Six CSV reports behind one route: `SALES_SUMMARY`, `GST_HSN_SUMMARY`, `SPLIT_PAYOUT`,
`REFUND_SUMMARY`, `TOP_PRODUCTS`, `INVENTORY_MOVEMENT`. Six near-identical routes would be six
places to forget the date cap.

**Nothing is stored.** A report is generated from the ledger on request, so the figure in the file
is the figure the ledger holds now, not one that was true when somebody last pressed a button.

**The range is mandatory and capped at 366 days.** An unbounded aggregate over every order ever
placed is a denial of service the operator inflicts on themselves, usually at month end.

**Formula escaping is not optional.** Reports carry product names, and a name of
`=cmd|' /C calc'!A0` executes when the file is opened in Excel. The existing `escapeCsvValue`
prefixes any cell starting `= + - @ \t \r` with an apostrophe; a test round-trips a genuinely
malicious product name through `INVENTORY_MOVEMENT` and asserts it comes out inert.

### Every report reconciles against an independent figure

A report nobody checks is a number nobody should trust, so each total is matched against a value
computed from rows the report did not read:

| Report | Reconciled against |
| --- | --- |
| `SALES_SUMMARY` | the sum of the order snapshots |
| `GST_HSN_SUMMARY` | per-item tax, and separately against `SALES_SUMMARY`'s order-level tax |
| `SPLIT_PAYOUT` | transfers minus **reversal rows** from the ledger |
| `REFUND_SUMMARY` | processed refund rows, and `Order.refundedPaise` |
| `TOP_PRODUCTS` | the sum of `lineTotalPaise` |
| `INVENTORY_MOVEMENT` | inward minus outward from `InventoryLedger` |

`SPLIT_PAYOUT` emits `reversedFromRows` **and** `reversedFromCounter` side by side. They are two
independent records of one fact, and a report built on the counter alone could never notice the
counter drifting - which is exactly the bug that got through earlier in this prompt.

G1 applies to all of it: every reconciliation also asserts the compared figure is non-zero, because
`0 === 0` passes on an empty database.

## 26. CMS (Prompt 10A)

### The block registry is the contract

`shared/src/cms/blockRegistry.ts` is the single definition of what a block type is, and both the
backend validator and the Prompt 13 renderer read it. Each of the 22 entries carries a label, a
category, a Zod schema, a default config, and — declaratively — the config **paths** where its
media ids and entity references live:

```ts
mediaFields: ['slides[].mediaId', 'slides[].mobileMediaId'],
referenceFields: { productIds: ['productIds'], collectionIds: ['collectionId'] },
```

Because location is declared rather than coded, `mediaIdsIn()` and `referencesIn()` walk any block
type generically. There is **no `switch (type)` anywhere in the services**, which is what makes
"adding a block type is registry entry + Zod schema + React component, nothing else" true rather
than aspirational. A `BlockType` with no registry entry fails a test that iterates the enum.

### Save-time schema vs publish gate

**This is the same concept as the product publish gate in section "Publish gate" above, applied to
pages.** A thing may be stored half-finished; it may not be *shown to customers* half-finished.

| | Products (Prompt 5) | Pages (Prompt 10A) |
| --- | --- | --- |
| Save-time schema | product create/update schema — a `DRAFT` may lack media, price, category | `blockRegistry[type].configSchema` — a hero slider may have zero slides |
| Publish gate | `POST /admin/catalog/products/:id/publish` → 422 `PRODUCT_NOT_PUBLISHABLE` | `POST /admin/cms/pages/:id/publish` → 422 `PAGE_NOT_PUBLISHABLE` |
| Behaviour | returns **every** blocker at once | returns **every** blocker at once |

The save-time schema has to be tolerant or the builder is unusable: an admin drags a hero slider
onto the canvas and it has no slides yet. `publishSchema` is the stricter one the gate applies, and
it is only declared where it differs. Page blockers are `NO_BLOCKS`, `NO_TITLE`,
`BLOCK_INCOMPLETE` (with the block id, type and failing config path) and `BLOCK_REFERENCE_MISSING`
(with the offending ids) — so an editor fixing a homepage does not do it one 422 at a time.

### Hydration query budget

`GET /content/home` hydrates the seeded **13-block** home page (28 distinct products) in a
**measured 41 SQL statements**, guarded by a ceiling of **50**.

It was **125** until Prompt B1 batched the pricing context loader (section 27). Roughly 17 of the
41 are the pricing engine — now a flat cost — and hydration's own overhead is the remaining ~24,
guarded separately at **30**, and it is flat.

The ceiling alone is a weak guard, so `cms-hydration.test.ts` also asserts the property a ceiling
cannot express: **adding five blocks must cost exactly zero extra queries**. That is what fails the
moment somebody fetches per block. The renderer works in phases — collect what every block wants,
batch-fetch it, then map — and issues no queries at all after the mapping starts.

If the budget is ever exceeded the fix is batching, not a larger number.

### Caching and the keys

Rendered pages are cached per **(slug, customer group, device)**, because all three change the
answer: group changes prices inside product blocks, device drops whole blocks. Caching on slug
alone would serve a wholesale customer retail prices. Keys are registered in the one key map in
`catalogCache.service` — `cms:page:`, `cms:banner:`, `cms:faq:`, `cms:help:`, `cms:set:`,
`cms:sitemap:` — and invalidated from the write paths.

### The sanitiser allowlist

One allowlist, used by `CUSTOM_HTML`, `RICH_TEXT` and help articles, wrapping `sanitize-html`
rather than hand-rolled: a regex sanitiser is a well-known way to ship an XSS hole, and
`<scr<script>ipt>` defeats the naive version.

- **Schemes:** `http`, `https`, `mailto`, `tel`. `javascript:`, `vbscript:` and `data:` are absent
  by omission. Images are `http`/`https` only — a `data:` image is how an SVG-with-script arrives.
- **Dropped entirely, content and all:** `script`, `style`, `textarea`, `noscript`, `template`.
  Untagging leaves the payload sitting in the document as text, which is still the payload.
- **No `style` attribute**, no `on*` handlers, no `<form>`, no `<object>`.
- **Iframes** only from whitelisted hosts (`cms.whitelisted_iframe_hosts`, merged with built-in
  defaults). An iframe left without a `src` after filtering is removed rather than left standing.
- `target="_blank"` links gain `rel="noopener noreferrer nofollow"`.

Sanitising happens at **write** time and the result is stored; the raw input is kept in
`rawConfigJson` so an editor can keep working on what they wrote. Read paths never run a parser —
that would put it on the hot path of every render, and would mean the stored bytes are not the
bytes we vouched for.


## 27. Pricing loads in O(1) queries (Prompt B1)

`pricingContext.loader` used to do three lookups PER LINE inside its build loop: two `Category`
queries to expand ancestors, and one `VariantAttributeValue` query. A quote therefore cost
`18 + 3n` queries, which meant a 40-line cart issued 135. That cost was on every listing page,
every PDP, the cart, checkout and every CMS product block, and on a remote database each one is a
network round trip.

All three are now batched across every line before the loop runs. **A quote costs 18 queries
whether it has 1 line or 40.**

| Scenario | Before | After |
| --- | --- | --- |
| `quoteCart`, 1 line | 20 | 20 |
| `quoteCart`, 10 lines (a real cart) | 45 | **18** |
| `quoteCart`, 25 lines | 90 | **18** |
| `quoteCart`, 40 lines | 135 | **18** |
| Home page, 13 blocks / 28 products | 125 | **41** |
| Product listing, 24 products | 156 | **87** |
| PDP | 106 | **100** |

Category ancestors still resolve through the materialised `path` prefix exactly as before - the
expansion is simply computed once for every distinct category on the page and handed out from a
Map, instead of being recomputed per line.

`pricing.engine.ts` is untouched and still pure. Only the loader changed.

### How invariance was proved, and why not with a fixture

The obvious approach - record every breakdown before, replay after - was built and then thrown
away, because the control experiment failed: the ORIGINAL loader could not reproduce its own
recording either, 83 of 200 cases apart. The seed creates coupons and discount rules with windows
relative to its own wall clock, so which rules are live depends on WHEN the database was seeded.
A fixture recorded on Tuesday goes red on Thursday for reasons that have nothing to do with
pricing, and a test that cries wolf gets re-recorded until it means nothing.

`pricing-invariance.test.ts` proves it the stronger way instead. The rewrite touched exactly two
things, and both are compared against the original implementations - kept in the test file as
reference code - in the same database and the same process:

- the category expansion, for **every product in the catalog**
- the variant option values, for every default variant
- and both again across every line of 200 seeded-random quote cases

The engine is pure, so identical inputs give an identical `PriceBreakdown` and an identical
`contextHash`. That covers the whole catalog rather than a sample frozen at one moment.

## 28. Middleware factories cannot be mounted bare (Prompt B1)

Three times on this project a middleware FACTORY has been passed to Express as a handler. Express
calls it with `(req, res, next)`, throws away the handler it returns, never calls `next`, and
the request hangs until it times out. It cost a 30-second stall each time and is invisible in a
unit test.

**TypeScript does not catch it.** A probe confirmed that both of these compile clean:

`const handler: RequestHandler = optionalAuth;` and `router.get('/x', optionalAuth);`

because Express's `RequestHandler` call signature is checked bivariantly and its router overloads
widen. A return-type brand therefore cannot close the hole - the problem is the FACTORY being
accepted, not what it returns. So it is closed two other ways:

- **eslint** `no-restricted-syntax` over `backend/src/routes/**` and `app.ts` flags the known
  factory names used as a bare argument to a router method.
- **`tests/middleware-contract.test.ts`** walks the live Express stack and fails if any mounted
  handler has arity below 2, since every real middleware takes `(req,res,next)` or
  `(err,req,res,next)` while a factory takes its configuration. It also proves the check can
  fail, by mounting a deliberate factory and asserting it is caught.
- A behavioural backstop calls every mounted GET and fails if one never responds, so a hang shows
  up as a fast red test rather than a stalled CI job.

The factories are: `authenticate`, `optionalAuth`, `idempotency`, `validate`,
`requirePermission`, `requireAnyPermission`, `requireAllPermissions`, `requireRole`,
`authRateLimit`, `csrfProtection`.

## 29. The test suite (Prompt B1 Task 3)

**446s -> 63s warm, 259s cold.** 760 tests, nothing skipped or weakened.

Three changes, in order of how much they bought:

**A seeded TEMPLATE database, cached and copied.** `tests/global-setup.ts` migrates and seeds
once into a template in the OS temp directory, keyed by a hash of `prisma/schema.prisma`,
`prisma/migrations/` and everything under `prisma/seed/`. Change any of them and it rebuilds;
change none and a re-run skips the seed entirely - that is the 259s/63s difference.
`tests/setup.ts` then gives each test FILE its own file-copy.

**Parallel files.** A copy per file means there is no shared sqlite writer to serialise behind, so
`fileParallelism` is on. It also means no test can leak state into the next file, which removes a
class of order-dependent flakiness.

The ordering trick in `tests/setup.ts` matters: `DATABASE_URL` is set BEFORE anything imports
`src/config/prisma`, because the client reads the URL when the module is first evaluated. That is
why the imports in that file are dynamic.

**argon2 cost from config.** The suite hashes hundreds of passwords and the production profile is
memory-hard by design. `NODE_ENV=test` selects argon2's own minimum (1024 KiB, t=2) - still
argon2id, still salted. `tests/password-params.test.ts` asserts production, development, staging
and an UNSET `NODE_ENV` all get the OWASP profile, so this can never become a silent weakening of
a real security control on a live box.

**Also fixed:** the migrate and seed steps are subprocesses that load `backend/.env` rather than
vitest's overrides, so they now receive explicit local driver settings. Without that the suite
failed to boot the moment a developer pointed their `.env` at a real S3 bucket - the test
bootstrap must never depend on anyone's cloud configuration.

## 30. Site content is searchable (Prompt B1 Task 4)

`SearchDocument` accepted `PAGE` and `HELP_ARTICLE` from 10A but nothing ever wrote them. The
indexer now does: published, in-window, non-`noIndex` pages and published help articles, indexed
from the SANITISED html flattened to text, because that is the copy a reader actually sees.

Triggered through the existing emitter: the CMS cache invalidators emit `content.changed`, and
the subscriber reindexes and prunes. `reindexAll` covers both types.

Help category **re-parenting is implemented**, using the same `utils/materializedPath`
`recomputeSubtree` the category tree uses rather than a second implementation. A rejected move -
depth cap or cycle - restores the previous parent and recomputes, so nothing is left half-moved.

## 31. Performance budgets (Prompt B2 Task 2)

Development runs on SQLite over a local file, where a query costs microseconds and a hundred of
them are invisible. Production runs on a hosted MySQL over a network, where every query is a round
trip. A page issuing a hundred queries is free on a laptop and is a tenth of a second of pure
latency before any work is done. Budgets are therefore a COUNT, not a duration: counts are
deterministic and reviewable, durations depend on whichever machine ran the test.

The table lives in `backend/src/perf/queryBudgets.ts` and is enforced by
`backend/tests/query-budgets.test.ts`. Numbers are measured cold, with page caches dropped.

| Path | Before B2 | Now | Ceiling | Scale-invariant |
| --- | --- | --- | --- | --- |
| PDP `GET /catalog/products/:slug` | 100 | 79 | 88 | n/a |
| Listing `GET /catalog/products` | 87 | 46 | 52 | yes - 6, 24, 48 products |
| Home `renderHome` | 41 | 41 | 46 | yes - 13 and 18 blocks |
| `quoteCart` | 18 | 18 | 20 | yes - 1 and 40 lines |
| Cart read `GET /cart` | 50 / 77 | 36 / 36 | 42 | yes - 1 and 10 lines |
| Checkout init `POST /checkout/init` | - | 80 | 90 | yes - 1 and 5 lines |
| Search `GET /search` | 91 | 52 | 58 | yes |
| Category landing | 3 | 3 | 6 | n/a |
| Admin order detail | - | 42 | 48 | n/a |

**Scale invariance is asserted as equality, not as a ceiling.** A ceiling cannot tell a batched
query from an N+1 whose list happens to be short in the seed data. The test compares the per-table
READ profile at two response sizes and requires it to be identical. Writes are counted but not
compared exactly, because a fire-and-forget event handler may or may not land inside the
measurement window; a per-line WRITE pattern is still caught, since at one line against ten it
would differ by nine rather than by one.

**Targets that were not reached.** The brief asked for 25 on the PDP, the listing and the home
page. None is reachable without changing a displayed price, because one `quoteCart` costs 18 on
its own and every priced page inherits that floor. The PDP is 79 because it issues three quotes
that cannot be merged into one cart - the variant price deltas, the product itself at the
requested quantity with coupon and pincode, and the related rail - and merging any two changes the
cart subtotal that free-shipping thresholds, cart-level coupon allocation and quantity tier bands
are evaluated against. Each ceiling is its measured floor plus a small margin, and the reason is
recorded in the table's `note` field.

**Raising a budget requires a recorded justification, not an edit.** Every entry that missed its
original target carries the floor and the structural reason in `note`. The test asserts that a
note exists. Changing a number without adding the reasoning turns the budget into a rubber stamp.

### Deduplication is allowed; caching over an N+1 is not

These look similar and are not. `backend/src/utils/requestScope.ts` is the allowed one and its
header states the rule; this section exists so the distinction is not cited later for the wrong
thing.

**Allowed - request-scoped deduplication of identical work.** Two places in ONE request ask for
the same thing with the same arguments, and the second joins the first's in-flight promise.
Nothing is remembered past the response, so a write in the next request is seen immediately. The
PDP's three quotes share the half of the pricing context that does not depend on the lines -
customer group, default tax class, shipping zone and rates, active rules, the first-order check -
and the product rows and category ancestry when two quotes ask for the same set. That is what took
the PDP from 100 to 86 to 79 and the cart read from 43 to 36.

**Banned - caching to meet a budget.** A cache in front of a per-item query pattern leaves the
pattern in place. The first request after an invalidation still pays it, the cost still grows with
the number of items, and the budget passes while the problem is untouched.

**The test that separates them:** does the number of queries grow with the number of items in the
response? If yes, batch the query - a memo only moves the cost. A key that is constant for the
whole request, or that names an entire set rather than one line of it, cannot grow with the item
count and is deduplication. A key containing one item's id can, and is not.

The two N+1s B2 removed were batched, not memoised: the cart resolved a gallery per line
(`galleryResolver.resolveManyProductGalleries` now issues one `IN` query), and the facet builder
re-read the same attribute-value pairs once per filterable attribute (`facet.service.ts` now reads
them once per distinct candidate set).

## 32. Seeded data does not move with the wall clock (Prompt B2 Task 1)

A database that is a function of WHEN it was created cannot support a reproducible bug report, a
stable demo or a recorded fixture. `backend/prisma/seed/epoch.ts` exports `SEED_EPOCH` - read from
the environment, defaulting to `2026-01-01T00:00:00.000Z` - plus `epochPlus`/`epochMinus` and the
named windows (`ALWAYS_ACTIVE_FROM`, `LONG_EXPIRED_*`, `NOT_YET_STARTED_*`) every seed file uses
instead of arithmetic on `Date.now()`.

`scripts/check-seed-dates.mjs` (`npm run check:seed-dates`, part of `npm run check`) fails the
build on `Date.now()` or a bare `new Date()` anywhere under `backend/prisma/seed/`, and fails if it
finds no files to scan so it cannot pass by looking at nothing.
`backend/tests/seed-determinism.test.ts` runs the guard against a synthetic offender to prove it
catches one, and prices the same cart at the epoch and 400 days later to prove the result is
identical.

**A correction to the premise.** B2 was written on the understanding that coupon and discount-rule
validity windows were seeded relative to the wall clock, so which rules were live depended on when
the database was seeded. That is not what was happening. Recording 200 pricing fixtures, deleting
the template database, seeding again from scratch and diffing gives 0 of 200 differences. The 83
of 200 that Prompt B1 saw were a fault in the fingerprint, not in the seed: cuids appear inside
component codes such as `ADJ_<cuid>`, and the normaliser matched only strings that were entirely a
cuid, while a word-boundary pattern also failed because `_` is itself a word character. With
`/c[a-z0-9]{24}(?![a-z0-9])/g` the fixtures are byte-identical across independent seeds, and
`backend/tests/pricing-fixture.test.ts` now asserts that against a committed 200-case fixture.

The anchoring was still worth doing, but for the honest reason rather than the assumed one: it
fixes demo cart idle times, order expiry, the homepage countdown and `publishedAt` stamps. It is
not a pricing fix, because pricing was never broken.

## 33. Query visibility in development (Prompt B2 Task 3)

`DEBUG_QUERY_COUNT` adds `X-Query-Count` and `X-Query-Ms` to every response and logs the count,
the total database time, the slowest statement and its duration under `query count`. It defaults
on in development, off elsewhere, and is FORCED off in production however the variable is set -
the slowest-statement text can contain data, and the header would describe the shape of the
database to a caller. `resolveQueryCountDebug` in `config/env.ts` holds that rule and is asserted
directly, including that setting the variable in production does not switch it on.

The budgets test only sees the paths someone remembered to add; this is the other half, so an N+1
on a route with no budget is visible while it is being written.

**Why it is built the way it is.** Prisma reports statements through an event emitter that does
not preserve async context: inside a `$on('query')` handler the request's storage is already gone
and the obvious implementation counts zero. A client extension does keep context, so every
operation brackets itself in `perf/queryInsights.ts` and the emitter credits its statements to
whichever operation is innermost. One consequence: the exported `prisma` is an extended client and
an extended client has no `$on`, so `config/prisma.ts` also exports `prismaEvents`, the
unextended client, for listener registration. The header is written from a wrapped
`res.writeHead` rather than `res.end`, because `compression` replaces `res.end` after this
middleware and has already flushed the head by the time the original is reached.

## 34. Concurrency is measured, not asserted (Prompt 17A)

SQLite took one writer at a time, so every concurrency guarantee in this codebase was designed
against a database in which the races could not happen. MySQL at REPEATABLE READ runs them for
real. Moving over turned four green tests red, and the first two diagnoses of why were both wrong.

### The rejection-classification contract

`backend/tests/helpers/concurrency.ts` runs N operations at once and puts every outcome in exactly
one bucket, decided by error CODE and never by message text:

| Bucket | Meaning |
| --- | --- |
| OK | it succeeded |
| REFUSED | the guarantee working - limit reached, capacity exhausted. The ONLY bucket that may be counted as "the rule held" |
| CONTENDED | a compare-and-set or optimistic-lock miss the application surfaced instead of resolving. The caller did nothing wrong. A defect |
| INFRA | pool timeout, connect error, deadlock. The operation never reached the guarantee, so it is not a result of anything |

An unclassifiable rejection fails the test loudly. `expectNoInfrastructureFailures` is asserted
before any judgement, because a count that includes INFRA measures the harness, not the code.

**It has now overturned two confident diagnoses.** The coupon test fired twelve operations through
a pool of five and returned exactly five successes, which looked conclusively like connection
starvation. Raising the pool to fifteen changed nothing: the real cause was a SECOND, unrelated
five - `MAX_CAS_ATTEMPTS`. Then the refund H2 failure was read as a MySQL concurrency defect and
measured zero contention and zero infrastructure failures; nothing had raced at all, and the fault
was in how capacity was claimed. The lesson is the general one: a bucketed measurement beats a
plausible story, and a number that matches your hypothesis is not evidence that it caused it.

### Predicated writes replace read-then-CAS

Three services read a row, computed a new value, and wrote it back with the old value pinned in
the WHERE clause, retrying a fixed number of times. That is invisible on SQLite and wrong on
MySQL: it fails for callers who had capacity, and a bounded retry turns into a refusal.

The replacements, in order of preference:

- **The test belongs in the WHERE clause, compared against the row's own columns.**
  `coupon.redemption.service.ts` increments `usedCount` only where it is below `usageLimit` - as a
  Prisma field reference, so there is no snapshot to go stale. `refundReservation.ts` claims order
  and transfer capacity with one `UPDATE ... WHERE paid >= refunded + reserved + amount`, because
  column arithmetic cannot be expressed in a Prisma filter.
- **An explicit row lock, when the decision needs several columns and a derived value.**
  `inventory.service.ts` opens its transaction with `SELECT id ... FOR UPDATE`, so both stock
  floors are evaluated under the lock that the write will take.

**A money write and its ledger row commit together or not at all.** The coupon slot and its
`CouponRedemption`, the stock balance and its `InventoryLedger` row, are each one transaction. The
coupon version previously compensated with a decrement in a catch block, which leaked a slot
permanently if the process died between the two statements. Compensation was deleted, not hardened.

### The nine-guarantee register

Recorded so the list cannot quietly shrink. "Measured" means a genuinely concurrent test exists.

| # | Guarantee | Measured | Status | Relies on | Explicit? |
| --- | --- | --- | --- | --- | --- |
| 1 | Coupon two-phase redemption | 10 OK / 2 REFUSED / 0 / 0; unlimited 12 / 0 / 0 / 0 | HOLDS | predicated UPDATE with a field reference, in one transaction with the redemption row | explicit |
| 2 | Stock adjust and its ledger | 10 OK / 0 / 0 / 0 | HOLDS | `SELECT ... FOR UPDATE` + one transaction | explicit |
| 3 | Refund over-refund guard (H2) | 2 OK / 3 REFUSED / 0 / 0 | HOLDS | `UPDATE ... WHERE paid >= refunded + reserved + amount` | explicit |
| 4 | Refund capacity reserved, not checked (H7) | 2 OK / 3 REFUSED / 0 / 0 | HOLDS | the same predicate, claimed before the provider call | explicit |
| 5 | Refund execution lock (H1) | covered by the H2/H7 runs | HOLDS | null-lock predicate on the refund row - still in the database | explicit |
| 6 | Gapless order numbering | 10 OK / 0 / 0 / 0, distinct and gapless | HOLDS | read-then-CAS that RETRIES (250 attempts, jittered) rather than throwing | explicit, but retry-budget dependent |
| 7 | Gapless document numbering | 10 OK / 0 / 0 / 0, distinct and gapless, prefix unchanged | HOLDS | as above | explicit, but retry-budget dependent |
| 8 | One ACTIVE cart per owner | 10 OK / 0 / 0 / 0, one row, one id | HOLDS | insert arbitrated by the unique index on `activeOwnerKey`, with a terminal read | explicit |
| 9a | Optimistic locking (`updateVersioned`) | 1 accepted / 4 STALE_RESOURCE | HOLDS | `updateMany` predicated on `version` | explicit |
| 9b | `Idempotency-Key` replay | 1 created / 4 told in-flight, one product | HOLDS | unique index on `(scope, key)` claimed before the handler runs | explicit |

Guarantees 6 and 7 are the two that hold by retrying rather than by locking. They measured clean at
ten-way concurrency, and their miss path retries instead of throwing, so contention is never
reported as a refusal - but the margin is a retry budget, not a lock, and that is worth knowing
before invoice volume grows.

No deadlock and no lock-wait timeout has been observed in any run to date.

## 35. Timestamps are never interpreted (Prompt 17A)

MySQL `DATETIME` carries no zone, so anything converting one to a JS `Date` has to decide which
zone it meant. Getting that wrong is silent and uniform: every timestamp moves by the local offset
and nothing errors.

It cost this migration a real bug. The test bootstrap serialises a seeded template to SQL; `mysql2`
parsed `2026-01-01 00:00:00` in the runner's Asia/Kolkata, and writing that back produced a dump in
which SEED_EPOCH was `2025-12-31 18:30:00`. Every test database was five and a half hours early.

The fix is `dateStrings: true` on the connection, not a pinned zone. **An uninterpreted value beats
a correctly interpreted one**: a pinned zone is still a conversion, and it is only right while
every reader agrees about it. A raw string has nothing to get wrong. `tests/datetime-utc.test.ts`
round-trips a deliberately awkward instant and re-reads a SEED_EPOCH-derived row.

It also settled an open question from B2: `pricing-fixture.test.ts` was failing because of this,
not because of an unordered query. The fixture was not re-recorded.

## 36. No test may render a connection string (Prompt 17A)

`repo-hygiene.test.ts` interpolated `DATABASE_URL` into an assertion message. On SQLite that was a
file path; on MySQL it is `mysql://user:password@host/db`, so the database password printed on
every failure of that test - and a CI log is exactly where that lands.

Assertions are made on the database NAME, via `new URL(...).pathname`.
`tests/no-connection-strings.test.ts` makes the rule mechanical rather than a matter of care: no
test file may interpolate a connection string into an assertion message, a `console` call, a thrown
`Error`, or an `expect()` subject. Quoted string literals are stripped before matching, so prose
that merely names the variable is fine while a template literal that interpolates it is not. The
guard proves it fires against a fixture written to temp and deleted.

## 37. The predicated-write sweep (Prompt 17A)

Every site that inspects the row count of a predicated write, and whether a zero there can ONLY
mean the business rule refused:

| Site                                               | Predicate                                                       | On zero rows                                                                  | Zero means only "refused"?                                             |
| -------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `coupon.redemption.service.reserve`                | `usedCount < usageLimit` (field reference)                      | COUPON_EXHAUSTED                                                              | yes                                                                    |
| `refundReservation.reserveOrder`                   | `paidPaise >= refundedPaise + refundReservedPaise + amount`     | REFUND_EXCEEDS_PAID                                                           | yes                                                                    |
| `refundReservation.reserveTransfer`                | `amountPaise >= reversedPaise + reversalReservedPaise + amount` | REVERSAL_EXCEEDS_TRANSFER                                                     | yes                                                                    |
| `refundReservation.confirm*` / `release*`          | `reserved >= amount`                                            | returns false                                                                 | yes                                                                    |
| `refundRepository.claimForExecution`               | `executionLockedAt IS NULL`                                     | REFUND_ALREADY_EXECUTING (a registered contention code)                       | yes - and it says so honestly                                          |
| `inventory.service.adjust` / `reserve` / `release` | none - an explicit `SELECT ... FOR UPDATE` instead              | the floor throws INSUFFICIENT_STOCK under the lock                            | yes                                                                    |
| `repositories/versioned.updateVersioned`           | `version = <the caller's>`                                      | STALE_RESOURCE                                                                | yes - the caller ASSERTED the version, so a miss is a true answer      |
| `stockReservationRepository.settle`                | `status = 'RESERVED'`                                           | returns false                                                                 | yes - idempotent by design                                             |
| `documentSequenceRepository.next`                  | `lastNumber = <read>`                                           | RETRIES; throws a plain Error only after 250                                  | n/a - never reported as a refusal                                      |
| `orderSequenceRepository.next`                     | `lastNumber = <read>`                                           | RETRIES; throws a plain Error only after 250                                  | n/a - never reported as a refusal                                      |
| `refreshTokenRepository.claim`                     | `usedAt IS NULL AND revokedAt IS NULL`                          | re-read: used means TOKEN_REUSE (family revoked), revoked means TOKEN_INVALID | no - deliberately: strict rotation treats a concurrent use as a replay |

`tests/predicated-writes.test.ts` enforces the shape mechanically: no `updateMany` may pin a
mutable column to a value the caller read earlier, outside the two sequence allocators which retry
rather than refuse. Identity columns are excluded - an id is not a snapshot.

## 38. The collation contract (Prompt 17A)

Both databases and all 108 tables default to `utf8mb4` / `utf8mb4_unicode_ci`, which is
case-INSENSITIVE. That is correct for anything a human types - an email, a slug, a coupon code, a
SKU - and wrong for anything generated. Two hashes differing only in case are two different hashes,
and a case-insensitive UNIQUE index on one can reject a legitimate value or treat two distinct
opaque identifiers as the same row. On a security token that is not a preference, it is a defect.

45 columns therefore declare `COLLATE utf8mb4_bin`, listed in `backend/src/db/caseSensitiveColumns.ts`
with a reason each. They fall into five groups: digests (13), credentials and signatures (4),
identifiers issued by a payment or courier provider (14), idempotency keys (3), and opaque values
we generate ourselves - session ids, share tokens, the derived cart owner key, S3 object keys, AWB
numbers (11). Every other string column stays on the table default: 848 `utf8mb4_unicode_ci` plus
45 `utf8mb4_bin` is exactly the schema's 893 string columns.

`utf8mb4_bin` rather than `utf8mb4_0900_as_cs`: the latter is case-sensitive but still applies
Unicode normalisation, and normalising a digest is precisely the surprise this list exists to
prevent. `_bin` compares bytes.

**No `id` column is in the list.** All 93 foreign keys target an id, and both sides of a foreign key
must share a collation.

**Why `utf8mb4_unicode_ci` and not `utf8mb4_0900_ai_ci`.** The 108 `CREATE TABLE` statements in the
committed initial migration already declared `utf8mb4_unicode_ci`, while the database default was
`utf8mb4_0900_ai_ci`. Aligning the database to the tables was one `ALTER DATABASE`; aligning the
other way would have meant rewriting a committed migration for no behavioural gain.

**Prisma cannot express this.** The schema language has no column-level collation attribute, so
`schema.prisma` is silent about it. The collation therefore lives in the migration SQL, which was
edited in place - `clearwood_prod` has never been deployed and the local database held zero rows,
so one migration that is right from the start beats a correction migration replayed forever.

Measured, not assumed: `prisma migrate diff --from-schema-datasource --to-schema-datamodel` against
the rebuilt database returns *"This is an empty migration"*. Prisma does not see column collation at
all, so it will not propose reverting it and `migrate dev` remains usable. The risk it leaves is
narrower and real: a NEW column added to one of these tables by `migrate dev` will be generated
without `COLLATE`, silently. `tests/collation.test.ts` is the control - it asserts every registered
column still reports `utf8mb4_bin`, and fails loudly if one is renamed away.

That guard proves the DDL. A second pair of tests proves the BEHAVIOUR, which a shape assertion
cannot: two digests differing only in case both persist and each is found alone, and the inverse on
a coupon code, where the lower-case twin is still rejected as a duplicate.

Index length was verified rather than trusted, since `InventoryLedger.reason` already cost one
3072-byte failure: the widest index in the database is `MediaUsage_mediaId_usageType_entityId_field_key`
at 2548 bytes.

## 39. Timestamps on the VPS (Prompt 17A)

112 columns default to `CURRENT_TIMESTAMP(3)`, so the server's own clock writes a value into every
one of them. A server on local time would therefore stamp local time into rows the application
believes are UTC - the same class of fault as §35, but arriving from the other side. The VPS
`time_zone` is pinned with `SET PERSIST time_zone = '+00:00'`.

## 40. Three database targets, and which is used where (Prompt 17A / H1)

| Who | Target | Round trip | Used for |
| --- | --- | --- | --- |
| A laptop running dev or tests | local Docker MySQL 8.0.46 on `127.0.0.1:3306` | 0.41 ms | everything day to day |
| The application in production | MySQL on the VPS, reached as `127.0.0.1:3306` FROM the VPS | sub-millisecond | serving requests |
| A laptop doing admin work | the VPS through an SSH tunnel on `127.0.0.1:3307` | 67 ms | migrate deploy, seeding, inspection |

**The application must NEVER run over the tunnel.** A product page issues 79 queries (§31). At
67 ms each that is a five-second page before any work is done. The tunnel is for schema and data
administration; the app talks to the database on its own host.

### The test suite refuses a non-local target

`tests/global-setup.ts` falls back to `DATABASE_URL`, and the intention is for that variable to
point at the hosted database. Without a guard, `npm test` would create and drop `clearwood_test_*`
databases on production, fifty-one files in parallel. It failed only because `clearwood_app` has no
CREATE DATABASE privilege there - an accident of configuration, not a control.

`tests/helpers/testTarget.ts` allowlists HOST **AND PORT**, defaulting to `127.0.0.1:3306` and
`localhost:3306`, and refuses the database name `clearwood_prod` outright whatever the host.
**A hostname check would not have been enough, and that is the whole point:** the tunnel makes
production answer on `127.0.0.1`, which looks as local as anything can. CI widens it deliberately
through `CLEARWOOD_TEST_ALLOWED_HOSTS`; nothing widens it accidentally. The refusal names the host
and port only - never the URL, the user or the password.

### Deploying the schema

Through the tunnel, with `prisma migrate deploy`. Not `migrate dev`: `clearwood_app` cannot create
databases, so there is no shadow database for it to use.

Measured: **127.5 s** for one migration of 108 `CREATE TABLE`s plus indexes, foreign keys and the
ledger - not the ten seconds a naive "108 round trips at 67 ms" estimate suggests, because indexes
and constraints are statements too.

### Seeding

Structural only, `SEED_DEMO=false`, `STORAGE_DRIVER=local` on the command so the S3 client is never
constructed. `ensureSeedMedia` is called from exactly two files and both are inside the demo
branch, so a structural seed touches no storage at all.

Measured: **270.3 s** for run one and **293.2 s** for run two, for roughly 1,000 rows. That is a
seed dominated entirely by round trips, and the verdict is plain: **future seeding must run ON the
VPS, not through the tunnel.** Re-running it from a laptop costs five minutes to change nothing.

Idempotency was proven rather than asserted: all 37 populated tables held identical counts after
both runs, and an `AppSetting` edited by hand between them (`catalog.default_page_size`, 24 -> 99)
still read 99 afterwards. The row's `updatedAt` moved, so the seed does touch it - it upserts - but
it does not overwrite an admin's value.

**Production is structural only and the homepage has zero blocks. That is intended:** `39-homepage`
and `40-banners` seed demo content, and a live shop should not launch with a demo homepage.

### The ledger repair, and what it says about green tests

The initial migration was applied to the local database through the mysql client rather than by
Prisma, so `_prisma_migrations` did not exist and Prisma believed the migration unapplied. It was
repaired with `prisma migrate resolve --applied`.

Worth recording: **811 tests stayed green throughout.** The suite builds its own template database
and never consults the developer ledger, so a green suite is not evidence that the development
database is in a state anyone would recognise.

## 41. Production will not boot on a placeholder secret (Prompt 17A / H1)

Several secrets are knowingly placeholders during development. A note in a document would be true
and ignored, so this is the same mechanism that already stops the UNVERIFIED shipping driver:
`src/config/productionSecrets.ts` throws during `config/env.ts` evaluation when `NODE_ENV` is
production and any of these still holds its shipped value, or is too short to be real:

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_ACCESS_SECRET`, `ADMIN_JWT_REFRESH_SECRET`,
`CART_COOKIE_SECRET`, `MEDIA_SIGNING_SECRET`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_EMAIL`.

The placeholder list is DERIVED from `backend/.env.example`, not typed out again - a second copy
would drift, and the copy that drifts is always the one doing the checking. It names every
offending key at once, because the person reading it is mid-deploy and needs the list rather than
the first item of it. It prints key NAMES only, never a value, not even masked. In development it
does nothing.

`npm run check:production` runs the same logic on demand. It is deliberately NOT part of
`npm run check`: it fails by design today, and a check people learn to ignore is worse than none.

The admin user currently in production was seeded as `admin@clearwood.local` with the placeholder
password. The boot refusal is what makes that safe to have done.

## 42. Shared state: the Redis cache and rate limits (Redis foundation)

Local development still needs nothing but Node and npm: `CACHE_DRIVER=memory` stays the default.
The PM2 cluster (four workers) runs `CACHE_DRIVER=redis`; with `memory` in production the app logs
a warning at boot, because every worker would keep its own cache and rate-limit counters.

### The cache contract (`drivers/cache/cache.driver.ts`)

- **Never throws for being unavailable.** `get` misses; `set`/`del`/`delByPrefix` log and carry
  on. Redis is an optimisation in front of MySQL, never a source of truth.
- **Values are plain JSON** in both drivers (`cache.codec.ts`). The memory driver stores the
  serialised text too, so development can never rely on a Date, Map or shared reference that
  Redis would not give back. A value that cannot be serialised, or is over
  `CACHE_MAX_VALUE_BYTES`, is simply not cached.
- **TTL:** `ttlSeconds <= 0` means "do not store"; nothing lives longer than 24 h; every Redis key
  is written with `SET ... EX`.
- **`wrap`** collapses concurrent misses for one key in one process onto one producer call.
  Use `wrap`, not get-then-set, for any read-through cache.
- **Keys** are `REDIS_KEY_PREFIX` (default `cw:`) + the namespaces in `catalogCache.service.ts`.
  Prefix deletion is SCAN + UNLINK over this prefix only - never `KEYS`, never `FLUSHDB`. Prefixes
  requested in the same tick share one SCAN pass.

### Failure semantics

| Situation                | Behaviour                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Redis down at startup    | the process boots; reads come from MySQL; it keeps reconnecting (back-off to 2 s)                                              |
| Redis lost after startup | commands fail at once (no offline queue); reads from MySQL                                                                     |
| Slow Redis               | `REDIS_COMMAND_TIMEOUT_MS` (500 ms) then MySQL                                                                                 |
| Unreadable entry         | a miss, and the entry is deleted                                                                                               |
| Invalidation that failed | remembered; reads under that prefix are misses until a replay succeeds (on reconnect, or on the next read) - never a stale hit |
| Expired entry            | Redis expires it (`EX`); nothing older than its TTL is ever returned                                                           |
| Readiness                | `/ready` is 503 only when MySQL is down; Redis down is 200 `degraded`                                                          |

### Multi-worker behaviour

There is no pub/sub: the cache itself is shared, so a delete issued by one worker is what every
worker reads next. Still per process, by design: `wrap` single-flight, the search synonym memo
(60 s), the provider-driver memo (60 s) and the permission cache (below).

### The permission cache stays in the process

`rbacService` keeps its entries in a process-local cache whatever `CACHE_DRIVER` says. The key
includes `permissionVersion`, which is read from MySQL on every request, so a revocation reaches
every worker immediately without sharing anything - and Redis never takes part in an authorization
decision.

### Rate limits

With `CACHE_DRIVER=redis` both limiters (`rateLimiter.ts`, `authRateLimit.ts`) count in Redis
(`{prefix}rl:{limiter}:{key}`, atomic INCR + PEXPIRE, bounded by the window). A bucket used by two
routes still counts each route separately. If Redis fails, counting continues per process: the
limit loosens to per-worker for the outage, but neither vanishes (fail-open) nor refuses everyone
(fail-closed). Account lockout in MySQL still guards logins.

### TRUST_PROXY

Default `false`. Behind nginx on the same machine: `loopback`. Accepts `loopback`, `linklocal`,
`uniquelocal`, IPs and CIDRs; refuses `true`, `*`, hop counts and `/0` at boot. Rate limits and the
audit log use the resulting `req.ip`.

### Tests

The Redis suites (`redis-integration`, `redis-app`) run only with
`CLEARWOOD_TEST_REDIS_URL=redis://127.0.0.1:6380` set, localhost only, under a per-run prefix they
delete afterwards. One of them runs a second OS process as the "other worker".

## 43. Catalog integrity, ordering and cache consistency (Prompt 3)

### Canonical code

| Concern                                                            | Canonical implementation                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Catalog writes (products, variants, matrix, media links, import)   | `backend/src/modules/catalog-admin/*`, `modules/media/*`                     |
| Storefront reads (listing, PDP, options, gallery, resolve, search) | `backend/src/modules/storefront/*` + `repositories/storefront.repository.ts` |
| Shared cached category reads (tree, detail, counts)                | `backend/src/services/category.service.ts`                                   |
| Every cache prefix and invalidator                                 | `modules/catalog-admin/catalogCache.service.ts`                              |

Legacy, kept deliberately: `services/product.service.ts` (Prompt 2 detail, only
`tests/catalog.test.ts` uses it; the storefront PDP is `modules/storefront/pdp.service.ts`) and
`productRepository.list` (no callers). `GET /api/v1/admin/catalog/categories` is the paginated,
filterable list in `adminCatalog.routes.ts` (it used to be shadowed by a second, full-tree
registration in `admin.routes.ts`, now removed); the tree is `GET .../categories/tree`.
`tests/api.test.ts` fails if any method and path is ever registered twice.

### Invariants the database enforces

| Invariant                                | Enforcement                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At most one default variant per product  | `ProductVariant.defaultMark` (TRUE or NULL) + `@@unique([productId, defaultMark])` + CHECK tying it to `isDefault`                                                                                         |
| At most one primary category per product | `ProductCategory.primaryMark` + unique + CHECK to `isPrimary`                                                                                                                                              |
| At most one PRIMARY image per product    | `ProductMedia.primaryMark` + unique + CHECK to `role = 'PRIMARY'`                                                                                                                                          |
| One live variant per option combination  | `ProductVariant.combinationKey` = sha256 of `attributeId=valueId` pairs sorted by attributeId (binary) joined with `&`; `@@unique([productId, combinationKey])`; NULL for option-less and deleted variants |

MySQL unique indexes allow many NULLs, so "TRUE or NULL" gives "at most one TRUE". The CHECKs
(`ProductVariant_defaultMark_check`, `ProductCategory_primaryMark_check`,
`ProductMedia_primaryMark_check`) live only in the migration SQL; Prisma does not diff them, and
`tests/catalog-integrity.test.ts` asserts they exist. Always write the flag and its mark together:
`mark(flag)` from `backend/src/utils/uniqueMark.ts`, and `combinationKeyOf()` from
`modules/catalog-admin/variantOptions.ts`. Value-belongs-to-attribute is validated in the service
(422), not by a foreign key.

### Concurrency

Every write that changes one of the invariants runs in `productRepository.withProductLock`
(`SELECT ... FOR UPDATE` on the product row), so two admins serialise per product. The unique
indexes are the backstop: a lost race surfaces as 409 `VARIANT_COMBINATION_EXISTS`, or as
409 `WRITE_CONFLICT` (Prisma P2034, deadlock/serialisation) which the client may retry. It never
produces zero or two defaults.

### Slugs

Soft-deleting a product moves its slug to `deletedSlug` and sets `slug = 'deleted-{id}'`, so the
slug is free for a new product at once. Restore reclaims it, or the next free `-2`, `-3`... Admin
DTOs show the original slug for a deleted product. Soft delete and restore are idempotent. Slug
redirects still reserve their source slugs.

### Ordering

`repositories/helpers.orderBy()` appends `id` to every ordering, and catalog repositories with
literal orderings name their tie-breaker. Paging over equal sort values never repeats or skips a row.

### Cache: no stale write after an invalidation

Each driver keeps an invalidation epoch (memory: a counter; Redis: `{prefix}!epoch`, INCR before
the sweep). `wrap()` reads the epoch before running the producer and stores the result only if
the epoch is unchanged (Redis: Lua compare-and-set). A request that read the database before an
admin write and its invalidation can return that value but never cache it. CMS pages, SEO sections
and pincode lookups now go through `wrap()` too.

Media invalidation is targeted: a gallery write drops the owning product's `sf:pdp:{slug}:`,
listings, suggestions and CMS pages; an asset write drops the same for every product using it
(looked up before a hard delete), plus banners; an unused asset drops only CMS pages and banners.

### Listing architecture

Measured here in Prompt 3 (the listing loaded every candidate and filtered/sorted in Node); rebuilt
in Prompt 4 - see §44.

## 44. The storefront listing read path (Prompt 4)

### Request flow

`GET /catalog/products` -> Zod (`storefrontListQuerySchema`) -> `storefrontFacade.listProducts`:

1. **Grid cache.** `sf:list:grid:<pricing audience>:<sha256 of every validated parameter except
includeFacets>` via `cache.wrap` (epoch compare-and-set, Prompt 3). Search (`q`) is not cached.
   The audience is `anon` for everyone priced like an anonymous shopper (§45).
2. **Prepare** (`productQueryService.prepare`): settings, category + subtree ids, collection,
   brand slugs, attribute values grouped by attribute, search hits for `q` (bounded by
   `SEARCH_MAX_RESULTS`), offset from page or fingerprinted cursor -> one `ListingFilter`.
3. **Page** (`listing.repository.page`): ONE parameterised SQL statement filters, sorts
   (`ORDER BY <sort keys>, p.id`), paginates (`LIMIT/OFFSET`) and returns total and price bounds
   through `COUNT(*) OVER ()` / `MIN/MAX(...) OVER ()`.
4. **Cards** for that page only (`findCards`), priced for the caller card by card from one pricing
   context (`pricingFacade.quoteEach`, §45).
5. **Facets** (`facet.service`, cached under `sf:facet:`) from SQL aggregates over the same filter.

`GET /catalog/filters` runs steps 2 and 5 only.

### What MySQL decides

| Concern                           | SQL                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live                              | `deletedAt IS NULL`, `status='ACTIVE'`, `publishedAt <= now`; visibility PUBLIC/CATALOG_ONLY for a listing, PUBLIC/SEARCH_ONLY for a search (§45)                                                                                                                                                                |
| Category (+descendants)           | `EXISTS ProductCategory ... categoryId IN (subtree)`                                                                                                                                                                                                                                                             |
| Collection                        | `EXISTS CollectionProduct`                                                                                                                                                                                                                                                                                       |
| Brand                             | `brandId IN (...)`                                                                                                                                                                                                                                                                                               |
| Attributes                        | per attribute: `id IN (ProductListingAttribute with value)` (specs and active-variant options, §45); OR inside, AND across                                                                                                                                                                                       |
| Price                             | `COALESCE(ProductListingIndex.minPricePaise, basePricePaise)`                                                                                                                                                                                                                                                    |
| Availability                      | made to order, or an active variant that is backorderable or has `stockQty - reservedQty > 0` (the card, facet and search index use the same rule); also applied always when `catalog.show_out_of_stock=false`                                                                                                   |
| Flags, rating, lead time, on sale | plain column predicates                                                                                                                                                                                                                                                                                          |
| Sort                              | PRICE (index price), NEWEST (`COALESCE(publishedAt, createdAt)`), POPULARITY (`COALESCE(ProductStat.popularityScore, soldCount)`), BEST_SELLING, RATING (+count), NAME_ASC, CURATED (collection position / category link position / product position), RELEVANCE (`FIELD(id, ranked hits)`); `id` is always last |

Pagination stays OFFSET: every sort key is an expression over a join, so MySQL sorts all matches
either way and a keyset cursor would not reduce the scan; the existing cursor encodes the offset.

### Prices

`ProductListingIndex` (one row per ACTIVE product) holds the default audience's price range
(basis in §45), computed by `listingIndex.service` through `pricingFacade.quoteEach`. It is
owned by the catalog, so the listing no longer depends on the search driver's `SearchDocument`
(which copies these numbers). It is navigation data only: every displayed card price is quoted live
for the caller. Refreshes are serialised per process and per product by row locks
(`SELECT ... FOR UPDATE`, taken in productId order), so a refresh that read older data cannot
overwrite a newer one.

Kept current by: product/variant/category/publish writes (`product.changed`), removals
(`product.removed`), pricing writes (targeted re-price, or one leased rebuild), CSV imports and
direct bulk actions (announced), and the listing reconciler (§45), which also covers price windows
that open or close without a write. Stock and sales events reuse the row instead of repricing.

### Facets

Unselected dimensions: one attribute-value aggregate (a plain `COUNT(*)` over
`ProductListingAttribute`, unique per product and value) and one `facetScan` grouped by (brand,
price bucket) that also yields availability, rating and flag counts. A dimension with a selection
gets its own statement with only that dimension removed. Flag counts are real counts.

### Measured (3,600 products, 3,018 in one subtree)

`CLEARWOOD_LISTING_BENCHMARK=1 npx vitest run tests/catalog-listing-benchmark.test.ts`
(`CLEARWOOD_LISTING_BENCHMARK_OUT=<file>` writes JSON, `..._ANALYZE=1` prints EXPLAIN ANALYZE,
`..._DDL=<statements>` tries candidate indexes on the throwaway database). Category grid page 1:
250 -> 98 ms, rows read 24,957 -> 13,369; grid + facets: 869 -> 172 ms; facet endpoint: 861 -> 92
ms; warm cache: 11 ms. Candidate covering indexes on `VariantAttributeValue` changed nothing
measurable and were not added. Prompt 5's larger-scale numbers are in §45.

---

## 45. Catalog correctness over time (Prompt 5)

### Visibility - the one rule

Every storefront path requires `status='ACTIVE'`, `deletedAt IS NULL` and `publishedAt` NULL or in
the past; then, by visibility (`shared/src/enums.ts`, predicates in `storefront.repository`):

| Visibility   | Category / collection / curated / whole-catalog listings, facets | Search results, autocomplete, search index | Own page, slug resolution, options, gallery, price, explicit links (related, batch, recently viewed, wishlist, CMS), cart |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| PUBLIC       | yes                                                              | yes                                        | yes                                                                                                                       |
| CATALOG_ONLY | yes                                                              | no                                         | yes                                                                                                                       |
| SEARCH_ONLY  | no                                                               | yes                                        | yes                                                                                                                       |
| HIDDEN       | no                                                               | no                                         | no                                                                                                                        |

DRAFT, ARCHIVED, scheduled (`publishedAt` in the future) and soft-deleted products appear nowhere.
The repository fixed the reachability rule already (the cart and slug resolution treated every
visibility except HIDDEN as live); the enum names fix the other two columns. Before Prompt 5 the
listing used the search set for browsing (SEARCH_ONLY listed, CATALOG_ONLY never shown anywhere),
`findCards` returned any product by id, and public quotes priced any product.
`tests/catalog-correctness.test.ts` walks every path for every state.

### Pricing semantics

- **Listing filter and sort price** (`ProductListingIndex.minPricePaise`, max for the range): for
  each active, non-deleted variant (the base price when there is none), the engine's
  `unitPricePaise` for ONE unit bought on its own, channel WEB, no customer - so the DEFAULT
  customer group and `isFirstOrder=true` - no coupon, no pincode, at the refresh time. That is
  steps 1-7 of §15 (base, price list, tier at qty 1, adjustments, customisation, group discount).
  Line discount rules, coupons, shipping and GST are not in it.
- **Displayed card price**: the same `unitPricePaise`, for the caller's own group and
  `isFirstOrder`, for the product's DEFAULT variant, at request time.
- `pricingBasis` is `CUSTOMER_GROUP:<code>` whenever the caller's group is not the default group,
  whether or not it has a blanket discount; otherwise `DEFAULT_GROUP`.
- Step 6 (the group's `discountBp`) was documented but never applied; engine version 2 applies it
  once per unit, on the running price after adjustments and customisation, rounded half-up, as a
  `CUSTOMER_GROUP` component. A group price list, tier or adjustment runs first; the blanket
  discount then applies on top of it (the documented order).
- Catalog surfaces (cards, option deltas, the index) price each item as if bought alone
  (`quoteEach`: one context load, the pure engine run per line). Through `quoteCart` every card
  saw `cartItemCount` = the page size, so a rule conditioned on it changed a card's price with the
  number of cards on the page. Carts still price as carts.

### The listing reconciler (`listingReconciler.service`)

Every API process offers to run it every `LISTING_RECONCILE_INTERVAL_SECONDS` (default 60; 0 = no
timer, schedule `npm run listing:reconcile` from cron instead). A `MaintenanceTask` row is the
lease: taken by a compare-and-set `UPDATE ... WHERE leaseExpiresAt < now`, renewed between batches
(`LISTING_RECONCILE_LEASE_SECONDS`, default 300), released on completion or failure, and simply
expiring if its holder dies. One process works; the others return at once. A pass covers
`(watermarkAt, now]` and re-prices:

1. products reached by PriceAdjustment / PriceList windows that opened (`startsAt` in the span) or
   closed (`endsAt` in `[from, to)`) for the default audience, and weekday-conditioned rules at each
   UTC midnight; a GLOBAL rule, or a pending rebuild request, re-prices everything;
2. products MySQL itself says are stale - no row, or a product/variant row written after its index
   row was computed (up to 2,000 per pass) - which repairs lost or forgotten events;
3. then prunes rows nothing can list, drops the price-bearing caches, and advances the watermark -
   only if it still holds the lease. Discount-rule and auto-coupon windows only drop caches.

Re-pricing is idempotent, so a span processed twice is wasted work, never a wrong price.
`pricing.changed` without product ids (price lists, tiers, groups, imports, GLOBAL or wide rules)
no longer rebuilds in the worker that saw it: it raises the durable `rebuildRequestedAt`, and the
lease holder rebuilds once for any number of requests. Price-adjustment writes re-price exactly
the products their old and new targets reach (up to 500 inline). Coupons, discount rules, shipping,
pricing settings, tax classes and group membership never touch the index. Category tree moves,
collection membership and attribute changes ask for a rebuild only when a live rule reads that
fact.

### ProductListingAttribute

One row per (product, attribute value) the product answers to: specs plus active-variant options.
Written in the same locked transaction as the product's price row, deleted with it, rebuilt by
`rebuildAll`, cascaded when a value or attribute is deleted, and repaired by the reconciler like the
price row. Attribute filters and attribute facet counts read only this table. No attribute is
special-cased.

### Availability

One rule, `catalog-admin/availability.ts` (SQL twin `IN_STOCK` in listing.repository): a variant
is orderable when its product is made to order, it accepts backorders, or `stockQty - reservedQty

> 0`; a product when any active variant is. Card, swatch (it used to ignore backorder and made to
order), PDP, option matrix, search document, filter and facet use it. A reservation or release
that flips a variant's availability emits `inventory.changed`, so cached grids follow; holds that
> leave it orderable change nothing a shopper sees and announce nothing. Checkout's locked
> reservation remains the final check; the cache is never authoritative.

### Caches keyed on whose prices they show

`productQueryService.pricingAudience`: anonymous shoppers and signed-in shoppers of the default
group who have not ordered yet share `anon`; everyone else gets `g<groupId>:first|returning`.
Grid, landing and CMS page caches use it (CMS pages were keyed on a group id the controller never
set, so the first renderer's prices reached everyone). PDPs stay keyed per customer.

### Card payload

Cards carry the SMALL and MEDIUM renditions only (`CARD_RENDITION_LABELS`, from §13's documented
uses), in every format the ladder produced, plus the original `url`. Galleries keep the whole
ladder. A 24-card grid page: 89 KB -> 56 KB.

### Measured (one local machine: MySQL 8.0.46 in WSL, memory cache; not a production guarantee)

`CLEARWOOD_LISTING_BENCHMARK=1 CLEARWOOD_LISTING_BENCHMARK_PRODUCTS=<total>` (`..._REBUILD=1` also
times a full rebuild). The fixture: 80% under a 3-level, 48-leaf subtree, 1-4 variants, collections,
and a lifecycle mix (drafts, archived, hidden, search-only, catalog-only, scheduled, deleted).

| Products               | Grid p1       | Grid + facets   | Filtered + facets | Facet endpoint  | Full rebuild                               |
| ---------------------- | ------------- | --------------- | ----------------- | --------------- | ------------------------------------------ |
| 3,600 before -> after  | 109 -> 118 ms | 180 -> 140 ms   | 108 -> 117 ms     | 75 -> 55 ms     | 116 s / 181,616 q -> 10 s / 4,842 q        |
| 50,000 before -> after | 510 -> 533 ms | 2,015 -> 985 ms | 1,587 -> 660 ms   | 1,589 -> 429 ms | (~25 min extrapolated) -> 142 s / 65,177 q |

What remains is linear in the scope: a category covering 37,000 products scans them, joins their
index and stat rows and sorts, ~0.4 s cold at 50,000 (10 ms warm). Deep pages cost the same as page
1, so OFFSET is not the problem.

## 46. Performance foundation (Prompt 5B)

Sized for the stated ceiling of **1,000 products**. Nothing here changes a price, a filter or a
response shape; `tests/mutation-consistency*.test.ts` hold that line (below).

### What changed and why

- **Search reads short columns, and prepares text once per checksum.** The window scan
  (`searchDocumentRepository.scanHeads`, newest-popular first by `popularityScore DESC, id DESC`)
  reads ids, titles, boosts and the checksum only. `SqlSearchDriver` keeps normalised text in a
  per-process LRU (`SEARCH_MEMO_MAX_DOCUMENTS`, default 10,000; 0 disables) and fetches the long
  columns (`texts`) only for documents whose checksum it has not seen. Every query compares the
  checksum it just read, so an edited document can never be scored on its old text. Ranking is
  identical to the unmemoised path. When the index outgrows the window (2,000 documents) and the
  window holds too few precise hits, `headsWithEveryWord` supplements it; at 1,000 products it never
  runs.
- **Pricing configuration is cached; pages still are not.** Shipping zone per pincode
  (`price:ship:zone:`), rates per zone (`price:ship:rates:`), the default tax class and the default
  customer group (`price:set:`) are wrapped for `PRICING_CACHE_TTL_SECONDS`. `invalidatePricing`
  drops both prefixes and every group, tax-class, zone, rate and pincode write calls it. Discount
  rules and coupons are NOT cached (usage counts move at checkout).
- **A cart read loads its facts and its quote once**, and hands both to validation, lines and
  delivery (`cart.service.toDto`).
- **Cards and the pricing context select only what they render** (`storefront.repository`
  `cardInclude` is a `select`; `pricingContext.loader` selects its product columns).
- **PM2 caps the old-generation heap** (`node_args: ['--max-old-space-size=384']`, beside
  `max_memory_restart: '512M'`). The flag is not an RSS limit: V8 reports a 576 MB
  `heap_size_limit` (old space plus young-generation reserve), and RSS also carries the Prisma
  engine. Without it, V8's lazy collection let RSS cross 512 MB under load and PM2 would recycle
  healthy workers.
- **Test teardown drains catalog events and the listing reconciler** before closing Prisma
  (`tests/setup.ts`). With work still in flight, `DROP DATABASE` sat in "Waiting for table metadata
  lock" until the 60 s hook timeout; draining first removed it.
- `queryBudgets.ts` baselines were re-measured; no ceiling moved. The ceilings stay above the
  cold-configuration count on purpose: configuration is warm in production, pages are cold.

### Not done, on purpose

Export batching (it fixed a heap OOM at 50,000 products, irrelevant at 1,000) and a composite
`SearchDocument` window index (no gain at 10,000). A `LIKE` prefilter for search was measured slower
and rejected.

### Consistency tests

`tests/mutation-consistency.test.ts` (memory cache) and `tests/mutation-consistency-redis.test.ts`
(real Redis, when `CLEARWOOD_TEST_REDIS_URL` is set) share `tests/helpers/consistencySuite.ts`:
admin writes through the API, public reads with caches warmed first. They cover price, inventory,
category, visibility/unpublish, variant price, group discount, default-group discount, tax rate,
shipping rate, search rename, memo-vs-no-memo ranking and the card key set. Each was verified to
fail when, in turn, `dropStorefront` was a no-op, product/inventory events skipped reindexing,
`invalidatePricing` kept `price:set:`/`price:ship:`, or the memo ignored the checksum.

### Harness

`tests/perf-baseline.test.ts` (opt-in, `CLEARWOOD_PERF_BASELINE=1`): `CLEARWOOD_PERF_PRODUCTS`,
`_RUNS`, `_CONCURRENCY` (e.g. `1,10,25,50,100`), `_SECONDS`, `_REDIS_URL`, `_NODE_ARGS`,
`_ONLY` (scenario keys; `none` = load only), `_OUT` (JSON), `_CPU_PROFILE_DIR`, `_EXPORT=1`. The load
test forks `tests/helpers/perfServer.ts` with an 8-connection pool. Both benchmarks build their
catalog with `tests/helpers/benchCatalog.ts`.

### Measured at 1,000 products (one local machine: 16 cores, MySQL 8.0.46 in Docker; not a production guarantee)

| Path (cold / warm p50)    | ms      | Statements (cold) |
| ------------------------- | ------- | ----------------- |
| Category grid + facets    | 53 / 8  | 28                |
| Filters                   | 40 / 9  | 31                |
| Search                    | 69 / 62 | 37                |
| PDP                       | 58 / 4  | 72                |
| Quote (3 lines + pincode) | 15 / 14 | 13                |
| Cart (10 lines)           | 35 / 35 | 30                |

One process, Redis, heap flag, pool 8: ~230 rps at 10 concurrent (p95 125 ms), ~257 rps at 100
(p95 919 ms, queueing), 0 errors, RSS 353-409 MB (590-606 MB without the flag, same throughput),
live heap after GC ~72 MB. With the memo disabled, warm search is ~102 ms and throughput at 10
concurrent falls to ~104 rps.

## 47. The dynamic catalog: admin control over time (catalog management phase)

The admin owns the catalog; MySQL holds it; Redis only remembers answers. Nothing below names a
category, attribute or product in code - behaviour hangs off `Category.kind`, product flags,
settings and rules.

### Visibility is effective, not per-row

A category is live only if it and every ancestor are active and not deleted
(`category.service.liveCategoryIds`, one fresh query - callers sit behind their own caches).
Deactivating a parent hides its whole subtree - tree, detail, listings, navigation, search, CMS,
redirects, PDP breadcrumbs - without touching the children's flags. A category cannot be restored
under a deleted parent (409 `CATEGORY_PARENT_DELETED`). Collections honour `startsAt`/`endsAt`
everywhere they surface (`storefront.repository.liveCollectionWhere`).

### Rule categories and time-aware merchandising (`modules/storefront/merchandising.ts`)

- `NEW_ARRIVALS`, `SPECIAL_COLLECTION` and `MAKE_YOUR_OWN` categories are rules: they list their
  explicit links plus every product in the parent's subtree (the whole catalog for a root) with the
  fact - new arrival, `isSpecialCollection`, `allowCustomization`. Judged in the listing SQL.
- New arrival = the `isNewArrival` override, or live (`publishedAt`, else `createdAt`) within
  `catalog.new_arrival_days` (default 30; 0 = flag only). Featured = `isFeatured` until
  `featuredUntil`. Cards, the PDP, the listing filter, automatic-collection rules and the search
  boost all use the same predicates.
- Badges are data: `catalog.badges` names which codes show and their words; a product's own
  `badgeText`/`badgeColor` comes first. No badge word exists in code.
- Publishing takes an optional `publishAt`: a future date schedules the product (`SCHEDULED`).

### The clock is reconciled, not flushed

The listing reconciler (§45, one MySQL lease across PM2 workers, watermark per span) gained a
schedule phase (`catalogSchedule.repository`, half-open spans): scheduled products that went live
get their search documents, ended featured windows lose their boost, new-arrival expiries and
collection windows drop the caches that judged them (`invalidateSchedule`), AUTOMATIC collections
are re-evaluated quietly (announced only when membership changed) and `productCountCache` is
recomputed - rule categories counted by the listing SQL itself - whenever the catalog was written,
a boundary crossed or the UTC day changed.

### Admin surfaces added

- `GET/PUT /admin/catalog/settings` - page sizes, out-of-stock policy, new-arrival window, badges
  (merged per code; `null` switches one off). Audited as `SETTING_CHANGED`.
- `GET /admin/catalog/categories/:id/products`, `POST .../products/reorder` - the curated order
  `sort=CURATED` shows. `ProductCategory.position` is the product's place in that category: kept
  when links are rewritten, appended for a new link. Primary is `isPrimary`, never position 0.
- `POST /admin/catalog/collections/:id/restore`; the list takes `includeDeleted`.
- Bulk: `ACTIVATE` passes the publish gate and needs `catalog.product.publish`; `ADD_CATEGORY`,
  `REMOVE_CATEGORY`, `SET_MERCHANDISING`; targets validated once; targeted invalidation.
- Admin product list: compact rows (`publication`, flags, thumbnail) and filters for collection,
  publication, visibility, merchandising flags, customizable, made-to-order and created dates;
  `q` also matches variant SKUs; the stock filter uses the availability rule.

### Variants, import, media

- A variant's options must be active, variant-defining for the product (globally or via its
  primary category), and use the same attributes as its siblings (422
  `ATTRIBUTE_NOT_VARIANT_DEFINING` / `VARIANT_OPTIONS_INCONSISTENT`). The option matrix carries
  each value's `description`.
- CSV import applies the admin API's rules: enum and number validation, live references only,
  category cycle/depth checks with subtree path rewrites, variant options from the export's
  `attributeCodes`/`attributeValueCodes`, price rules validated by `priceAdjustmentCreateSchema`.
  A column the file does not carry is never written (it used to reset prices to 0).
- Moving a gallery item between product and variant moves its `MediaUsage` row; every gallery
  change refreshes `completenessScore`.

### Contract work and enquiries

`Contract Based Work` categories are kind `SERVICE` with `leadFormKey = 'contract-work'`: the
storefront shows the form, not a grid. `POST /api/v1/enquiries` (rate limited, CSRF when signed
in, honeypot) accepts a form key only while a live surface offers it - an active `LEAD_FORM`
navigation item, a live category's `leadFormKey`, or an active `LEAD_FORM_CTA` block. Admins work
the queue at `/admin/enquiries` (`lead.enquiry.read/update`; moving the owner needs
`lead.enquiry.assign`; optimistic locking; the audit diff holds workflow fields only). An enquiry is
never an order: nothing is priced, reserved or paid. No mail is sent (SMTP is on hold); Prompt 10B
builds its lead forms on this.

### The seed is create-only

Categories, attributes, collections and navigation items that exist are the admin's: a re-run
(every deploy) only adds what is missing. A category is matched by slug or by a slug it was
renamed from (`SlugRedirect`); a deleted one stays deleted with its seeded subtree; attribute links
are written only for categories the run creates. Navigation items match on what they point at,
menu-wide for categories (§48: a deleted item is no longer re-added). Demo data (`SEED_DEMO`)
still resets itself in development.

## 48. Catalog hardening: production seeds, scoped invalidation, relationships (Prompt 6)

No schema change and no migration: everything below is code over the existing tables.

### Seeds establish defaults; they never control production

Every structural seed is CREATE-ONLY, deleted rows included, so a deploy's re-seed can add what
is missing but never rewrite, reorder, re-activate or resurrect what an admin changed:

- Tax classes and customer groups are matched on `code`; a seeded default is only made default
  when no active default exists (never a second default, never a demoted admin choice).
- Rows the admin API HARD-deletes leave nothing to match, so the seed only writes them together
  with their owner: navigation items only for a menu, category or collection created in the same
  run (`seedCategories`/`seedCollections` return what they created); attribute groups only
  alongside a new attribute that needs them; search synonyms once, recorded by the private
  `seed.search_synonyms` setting.
- Collections renamed by an admin are found through their `SlugRedirect`, like categories.
- Brands are create-only; the demo catalog is attached only to demo SKUs and only to a brand the
  same run created, so an admin-created or deliberately unbranded product is never re-branded.
- Settings seeds keep the stored VALUE; only code-owned metadata (group, type, public flag) is
  refreshed - the admin API writes values only.

`tests/seed-idempotency.test.ts` edits and deletes every one of these before re-seeding.

### Invalidation is scoped to what was written

- CSV import collects what each chunk wrote and announces it only after that chunk commits:
  PRODUCT/VARIANT drop the product payloads once and re-price and re-index exactly those
  products (`invalidateProducts`); CATEGORY invalidates the nodes (the tree when one was created
  or moved); ATTRIBUTE_VALUE each changed attribute; PRICE_ADJUSTMENT the reach of every rule
  before and after (`announcePriceRules`, the admin API's own path). Navigation, settings,
  category-attribute and CMS FAQ/banner caches stay warm; a rolled-back chunk announces nothing.
- CMS pages are storefront renders of catalog cards: every storefront invalidation now drops
  `cms:page:` too, so a product, price, stock or badge change shows in cached CMS product blocks.
- `Category.productCountCache` follows the writes that move it at once (a coalesced per-process
  recount, `categoryCounts.service`, after product, removal and category events that can change
  a count); the reconciler still recounts on its schedule as the cross-worker backstop.

### Product relationships

`ProductRelation.type` is a code (D2): RELATED, SIMILAR, ALTERNATIVE, REPLACEMENT, COMPLEMENTARY,
FREQUENTLY_BOUGHT (frequently bought together), CROSS_SELL, UPSELL, BUNDLE_ITEM, VARIANT_OF_STYLE -
a new kind is one more code. `PUT /admin/catalog/products/:id/relations` refuses a self-relation,
the same product twice under one type and deleted products (422); a draft or hidden target may be
curated and simply never shows. The PDP adds `relationGroups` (every type in that order, members
by `position`, only products a shopper can open) beside `related` and `frequentlyBoughtTogether`.
`GET /catalog/products/:slug/related?type=` returns exactly that curated group - never the
category fallback, which only the untyped call uses. SIMILAR is mirrored onto the other product.

### Contract work stays out of the purchasable catalog

A `SERVICE` category takes enquiries, not products: filing a product under one is refused on every
write path (422 `CATEGORY_NOT_PURCHASABLE` - admin API, bulk ADD/MOVE, CSV import), and a category
holding products cannot become one (409 `CATEGORY_HAS_PRODUCTS`). The category tree and the
landing expose `kind` and `leadFormKey`, so the storefront opens the right form without naming a
category. The enquiry limiter is keyed per client (rotating the typed email buys nothing).
Enquiry notifications stay on hold with SMTP.

## 49. The catalog chain on `clearwood_prod` (Prompt 8 deploy)

Run ON the VPS (`/srv/clearwood`, commit `0e82ab3`), not through the tunnel: `migrate deploy` of the
five catalog migrations took 32 s, a structural seed 56-89 s.

- **`backend/.env` pointed at `clearwood_db`** (an empty database). Only the database name was
  changed to `clearwood_prod`; the pre-change file is kept in `~/clearwood-backups/env/`.
  `clearwood_app@127.0.0.1` holds ALL on `clearwood_prod` only.
- Backups (mysqldump, mode 600) in `~/clearwood-backups/db/`: before the migrations, and after the
  seed. All six migrations applied, checksums match, drift against `schema.prisma` is empty.
- The seed is create-only, so the 111 categories seeded by 17A kept their 17A labels ("Fabric",
  "All", "Special Collection"); the four missing groups (Bedroom Headboard, Furniture Pillows,
  Furniture Accessories, Contract Based Work) were added with their children. Positions
  the new rows shared with old ones were set to the reviewed order through the admin API, and the
  17A test leftover `catalog.default_page_size = 99` (above the max of 96, which made every
  catalog-settings update fail validation) was set back to 24.
- Verification ran against a temporary loopback-only production-mode instance with in-memory
  secrets and temporary admin accounts; everything it created was removed, audit rows kept.
- It found two search-index races, both fixed: concurrent upserts of one document (P2002) and
  overlapping whole-family rebuilds pruning newer documents (`tests/concurrency-search-index.test.ts`).
- The VPS has no PM2 and no Redis, `deployer` has no passwordless sudo, and the API is not running.
  `backend/.env` still has `NODE_ENV=development` (PM2 sets production), `AUTH_COOKIE_SECURE=false`,
  placeholder secrets and the placeholder admin email, so production cannot boot until the owner
  sets them (`npm run check:production`).
- The seed wrote mega-menu `menuColumn` values above 10 (11-13 in production, where Complete
  Interior Solutions and Bedroom Headboard share 11) while the admin API accepts 0-10. The seed now
  spreads the groups over 1-`NAVIGATION_MENU_COLUMN_MAX` (`tests/seed-navigation-limits.test.ts`),
  but it is create-only, so rows already in production keep 11-13 until corrected in the admin.
