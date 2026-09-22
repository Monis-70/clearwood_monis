# ClearWood Furnitures — Copilot / AI agent instructions

**Read `docs/PROJECT_CONTEXT.md` and `docs/ROADMAP.md` before writing any code.**
This file is the short, always-on version of the constitution. It outranks convenience.

---

## Product in one paragraph

ClearWood Furnitures is a premium Indian furniture e-commerce platform. USP: **100% in-house
manufacturing, zero outsourcing, every product manufactured individually.** It supports
made-to-order / customization ("Make your own &lt;X&gt;"). Three surfaces: public storefront,
a separate admin panel (separate domain later), and a REST API.

## Environment: LOCAL ONLY

No domain, no hosted DB, no S3, no Razorpay account yet. **Never** introduce Docker, MySQL or
Redis as a requirement. Everything must run on a clean Windows machine with **Node 20 + npm only,
offline**. Every external dependency sits behind a driver interface chosen by an env var, so
going live is a **config change, never a code change**:

```
DB       -> Prisma        now: sqlite file   later: mysql 8
CACHE    -> CacheDriver   now: memory        later: redis
STORAGE  -> StorageDriver now: local disk    later: s3
MAIL     -> MailDriver    now: log           later: smtp
PAYMENT  -> PaymentDriver now: mock          later: razorpay (Prompt 9)
```

## Folder structure (never change)

```
clearwood/
  backend/        Node 20 + Express 4 + TypeScript + Prisma
  frontend/web/   React 18 + Vite + TS + Tailwind  (storefront)
  frontend/admin/ React 18 + Vite + TS + Tailwind  (admin panel)
  shared/         shared types, Zod schemas, enums, constants, money utils
  infra/          nginx + pm2 configs (Prompt 17)
  docs/           constitution, roadmap, api/*.http files
```

Root npm workspaces: `["backend","frontend/web","frontend/admin","shared"]`.
TS path alias `@shared/*` → `shared/src/*` in every app.

## Reserved ports (never change)

`7180` backend API · `7181` storefront · `7182` admin · reserved: `7183` adminer, `3380` mysql, `6380` redis.

## Database discipline (SQLite now, MySQL later)

- **D1** Prisma provider comes from env — switched in one place. Prisma forbids `env()` in the
  `provider` argument, so `backend/scripts/sync-prisma-provider.cjs` writes `DATABASE_PROVIDER` into
  `schema.prisma` before every generate/migrate. Never edit that line by hand.
- **D2** No Prisma `enum`. Use `String` columns + TS const unions exported from `shared/src/enums.ts`.
- **D3** No `Json` scalar. Use `String` holding JSON + `jsonColumn<T>()` helpers
  (`backend/src/utils/jsonColumn.ts`).
- **D4** No `@db.*` native types, no MySQL-only features (fulltext, generated columns).
- **D5** **Money is INTEGER PAISE.** Never float. Convert to rupees only at the UI edge
  (`shared/src/money.ts`).
- **D6** Every model has `id` (cuid), `createdAt`, `updatedAt`; user-data models also get
  `deletedAt` (soft delete).
- **D7** Keep `docs/DB_MIGRATION_PLAN.md` accurate.

## Non-negotiable engineering rules

- **R1** Backend layering: `routes → controller → service → repository (Prisma)`.
  **Never** touch Prisma inside a controller.
- **R2** Validate every body / query / param with Zod. Invalid input ⇒ **422**.
- **R3** One response envelope, no exceptions:
  - success `{ "success": true, "data": <any>, "meta": <object|null> }`
  - error `{ "success": false, "error": { "code":"SNAKE_CASE", "message":"...", "details":<any|null>, "traceId":"<uuid>" } }`
- **R4** Single central error middleware + typed `AppError`. No stack traces in production responses.
- **R5** List endpoints accept `page`, `limit` (max 100), `sort`, `order` and return
  `meta {page,limit,total,totalPages,hasNext}`.
- **R6** All routes under `/api/v1` (`/health` and `/ready` are the only infra-level exceptions and
  still use the envelope).
- **R7** Every endpoint registered in the OpenAPI registry; browsable at `/docs`.
- **R8** No hardcoded business values — anything an admin might change lives in DB settings/config tables.
- **R9** Everything customer-facing is dynamic: adding a category / product / attribute / banner / FAQ
  in admin must appear on the storefront with **zero code change**.
- **R10** Security: `helmet`, CORS **allowlist (never `*`)**, `express-rate-limit`, `hpp`,
  `compression`, `httpOnly` + `sameSite` cookies, **argon2** hashing, secrets redacted from logs,
  Prisma parameterised queries only, never commit secrets.
- **R11** Every prompt ships: code + migration (if any) + `docs/api/*.http` + updated OpenAPI +
  README verification steps + passing tests.
- **R12** Never break earlier prompts — run the full test suite before declaring done.
- **R13** Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).

## Code conventions

- TypeScript `strict` everywhere. No `any` in exported signatures.
- `process.env` is read **only** in `backend/src/config/env.ts`; everything else imports `env`.
- Controllers are thin: parse → call service → `ok(res, data)` / `paginated(res, ...)`.
- Throw `AppError` (or a `ZodError`) — never `res.status(500).json(...)` by hand.
- Async route handlers are wrapped with `asyncHandler`.
- New env keys must be added to `backend/.env.example` **and** `env.ts` in the same change.
- New endpoints must be added to the OpenAPI registry **and** a `docs/api/*.http` file.
- Shared enums/const-unions live in `shared/src/enums.ts`, never duplicated per app.
- Design tokens live once in `shared/tailwind-preset.cjs`; both frontends consume it as a preset.

## Design system (from Prompt 12)

Warm, editorial, premium. Tokens: `--cw-bg #FAF7F2`, `--cw-surface #FFFFFF`,
`--cw-surface-2 #F2ECE3`, `--cw-ink #1E1A16`, `--cw-ink-soft #6B6058`, `--cw-clay #B4613A`,
`--cw-clay-dark #8F4A2B`, `--cw-walnut #8A5A3B`, `--cw-sage #7E8C77`, `--cw-line #E3DACE`,
`--cw-success #2E7D5B`, `--cw-danger #B23B3B`.
Radii 8/14/22/999 · shadow `0 10px 30px rgba(30,26,22,.08)` · display font Fraunces/Playfair
Display, body Inter · container 1280px · section padding 96/56 · breakpoints
360/640/768/1024/1280/1536 · framer-motion 200–400ms ease-out honouring `prefers-reduced-motion`.

## Current state

**Prompt 1 (Foundation & config) is the current scope.** Do not build catalog, products, payments
or UI pages until the roadmap says so.
