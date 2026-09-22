# ClearWood Furnitures — Roadmap (17 prompts)

Legend: `[x]` shipped · `[>]` current · `[ ]` not started.
A prompt may only be ticked when **R11** (code + migration + `.http` + OpenAPI + README steps +
passing tests) and **R12** (nothing earlier broken) are both satisfied.

- [x] **Prompt 1 — Foundation & config**
  - Constitution docs, npm workspaces, shared package, Express + Prisma skeleton,
    cache/storage/mail drivers, error envelope, OpenAPI at `/docs`, both Vite shells, tests.
- [x] **Prompt 2 — Database schema + full category seed**
  - Catalog domain (20 models), migration `catalog_core`, repository/service layer, the complete
    111-category site map, attribute dictionary with inheritance, DB-driven navigation,
    demo catalog behind `SEED_DEMO`, four read-only catalog/navigation endpoints.
- [x] **Prompt 3 — Auth & RBAC**
  - Two independent auth realms on one implementation, migration `auth_rbac`, argon2id passwords,
    rotating refresh tokens with family reuse detection, 86-permission registry with 5 seeded roles,
    CSRF double-submit, progressive lockout, OTP login/signup, and an audited admin panel login.
- [x] **Prompt 4 — Media service**
  - Full storage abstraction (local + S3 behind one interface), migration `media_library`, sharp
    rendition ladder with blurhash/LQIP/dominant colour, checksum deduplication, a media folder
    tree, a usage ledger that makes hard deletes safe, the public product gallery resolver, and the
    admin media library UI including the reusable `MediaPicker`.
- [x] **Prompt 5 — Admin catalog CRUD**
  - Migration `admin_catalog`, optimistic locking across eight models, slug redirects, the category
    delete strategies, the variant matrix, a ledger-backed inventory service, CSV import/export with
    formula-injection protection, bulk actions, `Idempotency-Key` replay and the admin category
    manager UI.
- [x] **Prompt 6 — Pricing engine**
  - Migration `pricing_engine`, a pure deterministic calculation core, customer groups, price lists,
    quantity tiers, stackable adjustments, coupons with a two-phase redemption ledger, discount
    rules, GST place-of-supply splitting, shipping zones/rates and the admin price simulator.
- [x] **Prompt 7 — Storefront catalog & search APIs**
  - Migration `storefront_search`, a swappable SearchDriver, the listing and facet engines, the
    one-call PDP, the option-availability matrix, AUTOMATIC collection evaluation, slug redirect
    serving, autocomplete, search analytics and the popularity model.
- [x] **Prompt 8 — Cart / wishlist / address**
  - Migration `cart_wishlist`, signed httpOnly guest carts, deterministic `lineKey` lines, the
    merge-on-login flow, live re-pricing through the Prompt 6 engine, cart validation with autoFix,
    wishlists with sharing and price drops, the address book with pincode autofill, recently-viewed,
    the lifecycle sweep and the admin carts screen.
- [x] **Prompt 9A — Orders, payment ledger, Razorpay Route split & checkout state machine**
  - Migration `orders_payments`, the PaymentDriver abstraction (mock + a production-ready Razorpay
    implementation), the pure split engine, the checkout flow with stock and coupon holds, the
    idempotent webhook pipeline, reconciliation and the ledger integrity checker.
- [x] **Prompt 9B — Fulfilment, shipments, refund execution, invoices, notifications, reports**
  - Migrations `fulfilment`, `refund_hardening`, `credit_note_refund_link`. Shipment state machine
    with derived order status, NDR and RTO handling, hardened refund execution (reserve → confirm,
    UNKNOWN ≠ FAILED), deterministic GST invoices and credit notes, eight order-lifecycle
    notifications with best-effort dispatch, and six reconciled CSV reports.
  - Customer-initiated returns are FROZEN behind `FEATURE_CUSTOMER_RETURNS` (default off, 404).
- [x] **Prompt 10A — CMS: pages, homepage builder, banners, FAQ, help centre, navigation, SEO**
  - Migration `cms_content` (13 models). The block registry in `shared/src/cms/blockRegistry.ts` is
    the contract the backend validates against and Prompt 13 will render from: 22 types, each
    declaring its media and reference config paths so the services need no per-type code.
  - Allowlist HTML sanitiser, page publish gate mirroring the product one, append-only revisions,
    hydrated public renderer with a measured query budget, and root-mounted sitemap/robots.
- [x] **Prompt B1 — Correctness and performance pass**
  - Pricing context loads in O(1) queries, middleware factories can no longer be mounted bare, and
    the test suite moved to a cached seeded template with per-file isolation (446s → 63s). Pages and
    help articles became searchable.
- [x] **Prompt B2 — Seed determinism, query budgets, query visibility**
  - `SEED_EPOCH` anchors every seeded date and a repository guard keeps it that way. Query budgets
    live in `backend/src/perf/queryBudgets.ts` with scale-invariance asserted as equality, and
    `DEBUG_QUERY_COUNT` reports per-request counts in development.
  - Correction recorded: the seed was already deterministic; B1's 83-of-200 fixture drift was a
    fingerprint bug, not a seeding one.
- [x] **Prompt 17A — SQLite → MySQL 8**
  - Rule D4 retired for an explicit `@db.*` type contract across 893 columns, one consolidated
    initial migration, and a test bootstrap that replays a serialised template per test file so
    per-file isolation and `fileParallelism` both survive the move.
  - Every concurrency guarantee is now measured with a rejection-classification helper rather than
    asserted; three read-then-CAS services became predicated writes or explicit row locks. Four of
    the nine guarantees in the register remain unmeasured — see PROJECT_CONTEXT §34.
  - Remaining for 17A-6: collations (all 897 string columns are still `utf8mb4_unicode_ci`),
    indexes, FULLTEXT search, and a reproducible docker/compose database.
- [x] **Database migration complete — schema and structural seed live on the VPS**
  - 45 columns collate `utf8mb4_bin` (digests, provider ids, opaque keys); the rest stay
    case-insensitive. `clearwood_prod` was deployed through the SSH tunnel and verified identical
    to local on all ten measures.
  - Structural seed only, `SEED_DEMO=false`: no demo catalog, and the homepage is intentionally
    empty. Proven idempotent across two runs with an admin edit preserved.
  - The test suite now refuses any target that is not local, by host AND port, and production
    refuses to boot while a secret is still its `.env.example` placeholder.
  - Still open: indexes, FULLTEXT search, and a reproducible docker/compose database.
- [ ] **Prompt 10B — Lead forms** _(next)_
- [ ] **Prompt 11 — "Make your own" configurator**
- [ ] **Prompt 12 — Frontend scaffold & design system**
- [ ] **Prompt 13 — Storefront pages**
- [ ] **Prompt 14 — Checkout & account**
- [ ] **Prompt 15 — Admin panel UI**
- [ ] **Prompt 16 — SEO / performance / accessibility polish**
- [ ] **Prompt 17 — Nginx + PM2 deployment + switch to MySQL / S3 / domain**

---

## Prompt 1 — delivered scope

| Area      | Delivered                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs      | `.github/copilot-instructions.md`, `docs/PROJECT_CONTEXT.md`, `docs/ROADMAP.md`, `docs/DB_MIGRATION_PLAN.md`, `docs/api/00-foundation.http`                           |
| Root      | npm workspaces, `tsconfig.base.json`, ESLint, Prettier, `.editorconfig`, `.gitignore`, `README.md`                                                                    |
| shared    | constants, enums (const-unions), API types, common Zod schemas, money utils (`splitPaise`), Tailwind token preset                                                     |
| backend   | env (Zod, conditional), pino logger, Prisma singleton, cache/storage/mail drivers, middleware stack, `AppError`, response helpers, `jsonColumn`, OpenAPI + Swagger UI |
| endpoints | `GET /health`, `GET /ready`, `GET /api/v1/version`, `GET /api/v1/settings/public`, `GET /docs`, `GET /openapi.json`                                                   |
| prisma    | `AppSetting`, `AuditLog`, migration `init_foundation`, idempotent seed                                                                                                |
| frontend  | storefront + admin Vite shells with design tokens, axios envelope client, TanStack Query, live API status page                                                        |
| tests     | Vitest + Supertest (backend), Vitest (shared money)                                                                                                                   |

**Out of scope for Prompt 1:** catalog, products, payments, auth, media, any business UI page.

---

## Prompt 2 — delivered scope

| Area         | Delivered                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared       | 17 new const-union enums, `types/catalog.ts`, `schemas/catalog.ts` (incl. the PriceAdjustment refinement), `booleanQuerySchema`, `resolveVariantBasePricePaise`, basis-point helpers                                                                                                                                                                                  |
| prisma       | `TaxClass`, `Brand`, `Media`, `MediaVariant`, `Category`, `AttributeGroup`, `Attribute`, `AttributeValue`, `CategoryAttribute`, `Product`, `ProductCategory`, `ProductAttributeValue`, `ProductVariant`, `VariantAttributeValue`, `ProductMedia`, `PriceAdjustment`, `Collection`, `CollectionProduct`, `NavigationMenu`, `NavigationItem` — migration `catalog_core` |
| repositories | category, attribute, product, variant, media, collection, navigation, priceAdjustment, taxClass + shared `notDeleted`/pagination/sort-allowlist helpers                                                                                                                                                                                                               |
| services     | categoryPath (build/recompute/cycle/depth cap), categoryAttribute (inheritance + `invalidateCatalogCache`), category, attribute, navigation, product mappers                                                                                                                                                                                                          |
| seed         | `seed.ts` orchestrator + `seed/01..07` + `seed/data/*`; 111 categories, 14 attributes / 95 values, 5 collections, 4 menus / 128 items, and a 14-product demo catalog behind `SEED_DEMO`                                                                                                                                                                               |
| endpoints    | `GET /api/v1/catalog/categories/tree`, `/catalog/categories/:slug`, `/catalog/attributes`, `/navigation/:key`                                                                                                                                                                                                                                                         |
| tests        | category paths & cycles, seed idempotency, tree/detail/attribute/navigation endpoints, attribute inheritance, PriceAdjustment refinement, product mapping                                                                                                                                                                                                             |

**Out of scope for Prompt 2:** product listing, filters, facets, search, PDP (Prompt 7), admin CRUD
(Prompt 5), price resolution (Prompt 6), media uploads (Prompt 4), customization (Prompt 11).

---

## Prompt 3 — delivered scope

| Area         | Delivered                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared       | 10 new const-unions + `PERMISSION_CODES` (86), `types/auth.ts`, `schemas/auth.ts`                                                                                                                  |
| prisma       | `AdminUser`, `Role`, `Permission`, `RolePermission`, `AdminUserRole`, `Customer`, `RefreshToken`, `OtpChallenge`, `VerificationToken`, `LoginAttempt`; `AuditLog` extended — migration `auth_rbac` |
| modules/auth | realm config, password (argon2id), token (JWT + rotation + reuse detection), cookie, csrf, rbac, otp, audit, admin-auth, customer-auth, admin-user, role                                           |
| drivers      | `OtpDriver` + `LogOtpDriver` + documented SMS/WhatsApp stubs                                                                                                                                       |
| middleware   | `authenticate(realm)`, `optionalAuth(realm)`, `requirePermission` / `requireAnyPermission` / `requireRole`, `authRateLimit`                                                                        |
| endpoints    | 9 admin-auth, 8 admin-management, 13 customer-auth, plus the guarded `GET /api/v1/admin/catalog/categories`                                                                                        |
| seed         | `08-permissions`, `09-roles`, `10-admin-user`, `11-demo-customers`                                                                                                                                 |
| frontend     | admin login / change-password / protected dashboard / `PermissionGate`, storefront `useCustomerAuth()`; both API clients gained CSRF headers and a single-flight cookie refresh                    |
| tests        | 48 new (password, realm isolation, rotation/reuse, RBAC, lockout, enumeration, CSRF, OTP, guard chain, audit)                                                                                      |

**Out of scope for Prompt 3:** 2FA (columns reserved), SMS/WhatsApp providers, admin UI beyond
login, customer login/register pages (Prompt 14), per-resource CRUD guards (Prompt 5).

---

## Prompt 4 — delivered scope

| Area          | Delivered                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared        | `MEDIA_STATUSES`, `RENDITION_LABELS`, `IMAGE_FORMATS`, `MEDIA_USAGE_TYPES`, `MEDIA_SOURCES`, `RENDITION_PRESETS` (8), `SYSTEM_MEDIA_FOLDERS`, `types/media.ts`, `schemas/media.ts`                                                                 |
| prisma        | `Media` extended (status, source, checksum, blurhash, LQIP, focal point, tags, usageCount, folder), `MediaVariant` extended, new `MediaFolder` + `MediaUsage` — migration `media_library`                                                          |
| drivers       | Full `StorageDriver` contract, `LocalStorageDriver`, `S3StorageDriver` (multipart, SSE, presigned uploads), key builder + HMAC signing helpers                                                                                                     |
| modules/media | `upload.validator` (magic bytes, SVG sanitising, filename defusing), `image.processor` (sharp ladder, blurhash, LQIP, dominant colour), `media.service`, `media-usage.service`, `mediaFolder.service`, `product-media.service`, `gallery.resolver` |
| endpoints     | 13 admin media, 4 media-folder, 5 product-media, 1 public gallery, plus the HMAC-verified `/media-signed/*` route                                                                                                                                  |
| seed          | `12-media-folders`, sharp-composed demo rasters pushed through the real upload pipeline, legacy SVG purge, usage-ledger backfill                                                                                                                   |
| frontend      | `/media` library (drag-drop, paste, progress, folders, filters, bulk delete), detail drawer (alt text, focal point, renditions, usage), reusable `MediaPicker`, `lib/mediaSrcSet.ts`                                                               |
| tests         | 31 new (validation, processing, dedup, storage parity local + mocked S3, traversal, signed URLs, RBAC, usage-aware deletion, gallery ordering, gc)                                                                                                 |

**Out of scope for Prompt 4:** video transcoding (uploads are stored as-is), a real virus scanner
(the hook exists and returns clean), CDN invalidation (Prompt 17), category/collection/CMS imagery
(Prompts 5 and 10 consume `MediaPicker`), and the full admin shell navigation (Prompt 15).

---

## Prompt 5 — delivered scope

| Area          | Delivered                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared        | 7 new const-unions, `schemas/catalogAdmin.ts` (60+ schemas), `types/catalogAdmin.ts`                                                                                                                                                                                 |
| prisma        | `version` on 8 models, `completenessScore`/`publishBlockersJson`/`lastPublishedAt` on Product, `reservedQty` on ProductVariant; new `SlugRedirect`, `InventoryLedger`, `ProductRelation`, `ImportJob`, `IdempotencyKey` — migration `admin_catalog`                  |
| catalog-admin | `catalogCache`, `slugRedirect`, `category.admin`, `attribute.admin`, `product.admin`, `variant.admin`, `variantMatrix`, `inventory`, `collection.admin`, `brand.admin`, `taxClass.admin`, `priceAdjustment.admin`, `bulkAction`, `import-export/{csv,export,import}` |
| middleware    | `idempotency(scope)` — optional `Idempotency-Key` replay with a bounded TTL                                                                                                                                                                                          |
| endpoints     | 50+ admin catalog routes across categories, attributes, brands, tax classes, products, variants, inventory, collections, price rules and import/export                                                                                                               |
| seed          | `13-brands`, `14-inventory` (opening stock through the ledger) and a completeness backfill                                                                                                                                                                           |
| frontend      | `components/ui/*` primitives (DataTable, FormDrawer, ConfirmDialog, Field, inputs, SlugInput, Toast), `useOptimisticVersion`, `AdminShell` with sidebar nav, `/catalog/categories` manager                                                                           |
| tests         | 52 new (locking, tree strategies, redirects, attribute guards, matrix, inventory concurrency and reservations, publish gate, duplicate, import/export, CSV injection, bulk, RBAC, idempotency, CSRF regression)                                                      |

**Out of scope for Prompt 5:** price calculation (Prompt 6), automatic-collection rule evaluation
(Prompt 7), order-driven reservations (Prompt 9 calls the reserve/release methods shipped here), and
the product/attribute/variant admin screens (Prompt 15 — only the category manager is built now).

---

## Prompt 6 — delivered scope

| Area      | Delivered                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared    | 11 new const-unions, `types/pricing.ts`, `schemas/pricing.ts`; `money.ts` extended with `roundHalfUp`, `applyBasisPoints`, `allocateProportionally`, `rupeeRoundingAdjustment`, `savingsPercentBp`, `splitGst`, `taxFromInclusive`                                                                                  |
| prisma    | Migration `pricing_engine` — `CustomerGroup`, `CustomerGroupMember`, `PriceList`, `PriceListItem`, `TierPrice`, `Coupon`, `CouponRedemption`, `DiscountRule`, `ShippingZone`, `ShippingPincode`, `ShippingPincodeRange`, `ShippingRate`; `customerGroupId`/`channel` on `PriceAdjustment`; `priceNote` on `Product` |
| engine    | `pricing.engine.ts` — pure, no Prisma/cache/clock; 12-step calculation order, qty-scaled components, invariant assertion; `condition.evaluator`, `adjustment.matcher`, `tier.resolver`                                                                                                                              |
| services  | `tax`, `shipping`, `discount`, `coupon.redemption` (compare-and-set + two-phase), `pricingContext.loader` (only Prisma toucher, with `explain` mode), `pricing.facade`, `pricingAdmin`                                                                                                                              |
| endpoints | 4 public (`/catalog/products/{slug}/price`, `/pricing/quote`, `/pricing/validate-coupon`, `/shipping/serviceability/{pincode}`) plus 40+ admin routes for simulate/explain/settings, groups, price lists, tiers, coupons, discount rules and shipping                                                               |
| seed      | `15-pricing-settings`, `16-customer-groups`, `17-shipping`, `18-coupons`, `19-tier-prices`, plus 3 demo price adjustments                                                                                                                                                                                           |
| frontend  | Admin `/pricing/simulator` (waterfall + rule trace + raw-JSON toggle) and `/pricing/coupons` (list, drawer, activate, redemptions)                                                                                                                                                                                  |
| tests     | 72 new — 39 engine (purity, ordering, tiers, GST, allocation, a 500-iteration invariant property loop) and 33 API (rejection codes, redemption concurrency, RBAC, cache invalidation)                                                                                                                               |

**Out of scope for Prompt 6:** cart persistence (Prompt 8), order totals and payment capture
(Prompt 9), customization surcharges (Prompt 11 fills the `customizationAdjustments` hook already
present in `PriceRequestLine`), and the storefront price UI (Prompt 12+).

---

## Prompt 7 — delivered scope

| Area      | Delivered                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared    | 10 new const-unions, `types/storefront.ts`, `schemas/storefront.ts`; the collection-rule whitelist moved into `enums.ts` and the Prompt 5 DSL widened to use it                                               |
| drivers   | `drivers/search/` — `SearchDriver` interface, a portable `sql` implementation (no FULLTEXT, no provider-specific SQL), a documented `meili` stub and a `createSearch(env)` factory wired into the container   |
| prisma    | Migration `storefront_search` — `SearchDocument`, `SearchSynonym`, `SearchQueryLog`, `ProductStat`, `SearchIndexJob`; `lastEvaluatedAt`/`evaluatedCount` on `Collection`                                      |
| events    | `events/catalogEvents.ts` + `events/subscribers.ts` — one bus, two listeners, so cache invalidation and reindexing can never drift apart                                                                      |
| services  | `searchIndexer` (price range via the P6 facade only), `productQuery`, `facet`, `optionAvailability`, `pdp`, `collectionRules`, `suggestion`, `searchAnalytics`, `popularity`, `redirect`, `storefront.facade` |
| endpoints | 19 public storefront/search routes plus 12 admin routes for synonyms, reindexing, analytics, index inspection and collection evaluation                                                                       |
| seed      | `20-storefront-settings`, `21-search-synonyms` (27 sets), `22-search-index`, `23-collection-evaluate`; the demo catalog grew from 14 to 71 products                                                           |
| frontend  | Admin `/search/analytics` and `/search/synonyms` (with a live test-search box and an inline reindex panel)                                                                                                    |
| tests     | 77 new — 51 storefront (listing, facets, PDP, options, collections, redirects, popularity, caching, RBAC, query budget) and 26 search (relevance, synonyms, injection, indexing, driver swap, analytics)      |

**Out of scope for Prompt 7:** the storefront UI itself (Prompts 12–13 consume these exact
endpoints), cart and wishlist counters feeding `ProductStat` (Prompt 8), review-driven ratings, and
moving the reindex job onto a real queue (Prompt 17 — the model is already in place).

---

## Prompt 8 — delivered scope

| Area      | Delivered                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared    | 9 new const-unions, `types/cart.ts`, `schemas/cart.ts`, the canonical 36 Indian states with GST codes, and the pincode/phone patterns                                                                                                                 |
| prisma    | Migration `cart_wishlist` — `Cart`, `CartItem`, `CartEvent`, `Wishlist`, `WishlistItem`, `Address`, `RecentlyViewed`; `Cart.activeOwnerKey` UNIQUE makes one-ACTIVE-cart-per-owner a DB guarantee                                                     |
| identity  | `cartIdentity` — 128-bit `randomBytes` session ids in a signed httpOnly cookie, verified with `timingSafeEqual`; a read never mints one and a tampered cookie is silently replaced                                                                    |
| services  | `cartPricing` (zero arithmetic — the P6 engine's breakdown verbatim), `cartValidation`, `cart`, `cartMerge`, `cartExpiry`, `cartAdmin`, `recentlyViewed`, `wishlist`, `address`                                                                       |
| endpoints | 25 customer-facing routes (cart, wishlist, addresses, recently-viewed) plus 6 admin routes for cart search, detail, stats, wishlist stats and the lifecycle sweep                                                                                     |
| auth      | The merge is wired into the EXISTING `customer-auth.service` login / OTP-verify / register success paths — no second auth flow                                                                                                                        |
| seed      | `24-indian-states`, `25-demo-carts` (active, abandoned, deliberately broken, guest), `26-demo-addresses`, `27-demo-wishlists` (default + shared)                                                                                                      |
| frontend  | Storefront `/cart` and `/wishlist`, a header badge on `/cart/summary`, optimistic quantity edits behind a serialised mutation queue; admin `/carts` with stats, filters, detail drawer and cleanup                                                    |
| tests     | 32 new — lineKey, guest cookie, component-by-component pricing equality with `/pricing/quote`, "stock is never reserved", concurrency (one cart, one line, no lost update), merge, validation, wishlist sharing, address defaults and ownership, RBAC |

**Out of scope for Prompt 8:** stock reservation and order creation (Prompt 9 — the cart
deliberately never reserves), checkout itself (Prompt 14), abandoned-cart recovery emails
(Prompt 16 — the `CartEvent` trail and the ABANDONED state are already there), and the configurator
lines that will hash into the existing `customizationHash` segment (Prompt 11).

---

## Prompt 9A — delivered scope

| Area      | Delivered                                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared    | 14 new const-unions (order/payment/transfer/settlement/refund/webhook/reservation/checkout/channel/basis), `types/order.ts`, `schemas/order.ts`; the Prompt 1 order and payment placeholders replaced in place                                                                                                              |
| prisma    | Migration `orders_payments` — `OrderSequence`, `Order`, `OrderItem`, `OrderAddress`, `OrderStatusHistory`, `Payment`, `SplitAccount`, `SplitRule`, `SplitAllocation`, `PaymentTransfer`, `Refund`, `RefundItem`, `TransferReversal`, `Settlement`, `SettlementEntry`, `WebhookEvent`, `StockReservation`, `CheckoutSession` |
| drivers   | `drivers/payment/` — the interface, a full deterministic mock simulator (real HMACs, split, refunds, reversals, settlements, on-demand webhooks) and a production Razorpay client over an injected HTTP client                                                                                                              |
| services  | `orderNumber`, `orderStateMachine`, `checkout`, `order`, `webhook`, `reconciliation`, `ledgerIntegrity`, `split.engine` (pure), `split.service`, `paymentAdmin`                                                                                                                                                             |
| endpoints | 11 customer/guest routes, 1 signature-authenticated webhook and 18 admin routes for orders, splits, accounts, settings, webhooks, reconciliation and the ledger check                                                                                                                                                       |
| seed      | `28-split-accounts`, `29-split-rules` (the ₹1,000 partner policy as data), `30-payment-settings`, `31-demo-orders` — which runs the REAL checkout against the mock driver rather than fabricating rows                                                                                                                      |
| frontend  | Storefront `/checkout`, `/order/:orderNumber` and `/track` on top of the permanent `useCheckout` / `usePaymentWidget` hooks; admin `/payments/split-rules` with a live split simulator                                                                                                                                      |
| tests     | 57 new — 17 pure split-engine cases (canonical ₹6,000, percent, clamping, ancestor scoping, zero-loss three-way, invariant violations) and 40 integration cases (L1–L5, webhook idempotency, COD, RBAC, secrets)                                                                                                            |

**Out of scope for Prompt 9A (this is 9B):** fulfilment and shipments, refund EXECUTION (9A creates
the `REQUESTED` row and stops), invoices, customer and admin notifications, the full admin order
management UI and the designed checkout UI (Prompt 14 — the data layer shipped here is permanent).

## Carried debt � OpenAPI documentation (owner: Prompt 15/16)

176 mounted routes from Prompts 1-8 are not in the OpenAPI document. They are enumerated in
`docs/openapi-debt.json` and held by a ratchet in `backend/tests/api.test.ts`: the list may only
shrink, and adding to it fails the suite.

| | |
| --- | --- |
| Mounted routes | 304 |
| Documented | 128 |
| Recorded as debt | 176 |
| Documented but not mounted | 0 |

Concentrated in `admin/catalog` (70) and `admin/pricing` (42). Everything from Prompt 9B item 9
onward must document itself. **Prompt 15/16 takes the debt to zero** by lowering `DEBT_CEILING`
until it reaches 0.
