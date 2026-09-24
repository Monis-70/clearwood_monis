import { isIP } from 'node:net';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

import {
  CACHE_DRIVERS,
  DATABASE_PROVIDERS,
  MAIL_DRIVERS,
  OTP_DRIVERS,
  PAYMENT_DRIVERS,
  SEARCH_DRIVERS,
  SHIPPING_PROVIDER_DRIVERS,
  STORAGE_DRIVERS,
} from '@shared/enums';

import { assertProductionSecrets } from './productionSecrets';

/**
 * The ONLY place in the backend that touches `process.env` (see .github/copilot-instructions.md).
 * Keys are required only when their driver is selected, so blank future keys never block startup.
 */

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

/** `KEY=` in a .env file yields an empty string; treat that as "not provided" so defaults apply. */
const source: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string' && value !== ''),
) as Record<string, string>;

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const TRUST_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * `false`, or the proxies Express may believe about X-Forwarded-For. Anything that would trust an
 * arbitrary network (`true`, `*`, a hop count, a `/0` range) throws: it lets a client pick its IP.
 */
export function parseTrustProxy(raw: string): false | string[] {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false') return false;

  const entries = csv(value);
  for (const entry of entries) {
    if (TRUST_PROXY_NAMES.has(entry)) continue;

    const [address = '', bits, extra] = entry.split('/');
    const family = isIP(address);
    const maxBits = family === 6 ? 128 : 32;
    const validBits =
      bits === undefined ||
      (/^\d{1,3}$/.test(bits) && Number(bits) >= 1 && Number(bits) <= maxBits);

    if (family === 0 || extra !== undefined || !validBits) {
      throw new Error(
        `"${entry}" is not allowed - use false, loopback, linklocal, uniquelocal, an IP or a CIDR`,
      );
    }
  }
  return entries;
}

const DEV_SECRETS = [
  'dev_access_secret_change_me',
  'dev_refresh_secret_change_me',
  'dev_admin_access_secret_change_me',
  'dev_admin_refresh_secret_change_me',
];

/**
 * The development bootstrap credentials. Both are committed to this repository and therefore
 * public: production refuses to boot on them, and `password.service` refuses the password as a
 * chosen password and as a production sign-in.
 */
export const DEV_ADMIN_PASSWORD = 'ChangeMe@12345';
const DEV_ADMIN_EMAIL = 'admin@clearwood.local';
const MIN_PRODUCTION_SECRET_LENGTH = 32;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().min(1).default('ClearWood Furnitures'),
    /**
     * Bind address. Loopback by default: until a reverse proxy with TLS sits in front of the API,
     * nothing outside this machine may reach it. Set `0.0.0.0` only deliberately.
     */
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    /** Which proxies may set X-Forwarded-For; rate limits and audit use the resulting `req.ip`. */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((raw, ctx) => {
        try {
          return parseTrustProxy(raw);
        } catch (error) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
          return z.NEVER;
        }
      }),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(7180),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),
    WEB_ORIGIN: z.string().url().default('http://localhost:7181'),
    ADMIN_ORIGIN: z.string().url().default('http://localhost:7182'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:7181,http://localhost:7182')
      .transform(csv)
      .pipe(z.array(z.string().url()).min(1)),

    DATABASE_PROVIDER: z.enum(DATABASE_PROVIDERS).default('sqlite'),
    DATABASE_URL: z.string().min(1).default('mysql://clearwood:clearwood@127.0.0.1:3306/clearwood_db'),

    CACHE_DRIVER: z.enum(CACHE_DRIVERS).default('memory'),
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\/\S+$/, 'must be a redis:// or rediss:// URL')
      .optional(),
    /** Every key starts with it, so one Redis can safely serve several apps or environments. */
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,30}:$/, 'lowercase letters, digits, _ or -, ending in ":"')
      .default('cw:'),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(500),
    CACHE_MAX_ITEMS: z.coerce.number().int().min(16).default(2000),
    /** A larger value is simply not cached, by either driver. */
    CACHE_MAX_VALUE_BYTES: z.coerce.number().int().min(1024).max(16_777_216).default(1_048_576),

    JWT_ACCESS_SECRET: z.string().min(8).default('dev_access_secret_change_me'),
    JWT_REFRESH_SECRET: z.string().min(8).default('dev_refresh_secret_change_me'),
    ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    REFRESH_TOKEN_TTL: z.string().min(1).default('30d'),
    COOKIE_DOMAIN: z.string().min(1).default('localhost'),

    // --- auth realms (Prompt 3). The customer realm reuses JWT_* above. ---
    ADMIN_JWT_ACCESS_SECRET: z.string().min(8).default('dev_admin_access_secret_change_me'),
    ADMIN_JWT_REFRESH_SECRET: z.string().min(8).default('dev_admin_refresh_secret_change_me'),
    ADMIN_ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    ADMIN_REFRESH_TOKEN_TTL: z.string().min(1).default('7d'),
    ADMIN_COOKIE_DOMAIN: z.string().min(1).default('localhost'),
    CUSTOMER_ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    CUSTOMER_REFRESH_TOKEN_TTL: z.string().min(1).default('30d'),

    AUTH_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    AUTH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    CSRF_ENABLED: z.enum(['true', 'false']).default('true'),

    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(10),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

    OTP_DRIVER: z.enum(OTP_DRIVERS).default('log'),
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(45),
    OTP_MAX_PER_HOUR: z.coerce.number().int().min(1).max(50).default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    SMS_API_KEY: z.string().min(1).optional(),
    SMS_SENDER_ID: z.string().min(1).optional(),

    ADMIN_SEED_EMAIL: z.string().email().default(DEV_ADMIN_EMAIL),
    ADMIN_SEED_PASSWORD: z.string().min(8).default(DEV_ADMIN_PASSWORD),
    ADMIN_SEED_NAME: z.string().min(1).default('Platform Owner'),

    STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('local'),
    LOCAL_UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),
    PUBLIC_MEDIA_BASE_URL: z.string().url().default('http://localhost:7180/media'),
    AWS_REGION: z.string().min(1).optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_PUBLIC_BASE_URL: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    S3_ACL: z.enum(['private', 'public-read']).default('private'),
    S3_UPLOAD_PREFIX: z.string().default('clearwood/'),
    S3_ENDPOINT: z.string().url().optional(),

    // --- media pipeline (Prompt 4) ---
    MAX_UPLOAD_SIZE_MB: z.coerce.number().int().min(1).max(500).default(15),
    MAX_UPLOAD_FILES: z.coerce.number().int().min(1).max(100).default(20),
    MAX_IMAGE_DIMENSION: z.coerce.number().int().min(256).max(12000).default(4000),
    ALLOWED_IMAGE_MIME: z
      .string()
      .default('image/jpeg,image/png,image/webp,image/avif,image/svg+xml,image/gif')
      .transform(csv)
      .pipe(z.array(z.string()).min(1)),
    ALLOWED_VIDEO_MIME: z
      .string()
      .default('video/mp4,video/webm')
      .transform(csv)
      .pipe(z.array(z.string())),
    ALLOWED_DOC_MIME: z
      .string()
      .default('application/pdf')
      .transform(csv)
      .pipe(z.array(z.string())),
    IMAGE_QUALITY: z.coerce.number().int().min(40).max(100).default(82),
    ENABLE_AVIF: z.enum(['true', 'false']).default('false'),
    GENERATE_BLURHASH: z.enum(['true', 'false']).default('true'),
    MEDIA_SIGNED_URL_TTL: z.coerce.number().int().min(30).max(86_400).default(900),
    MEDIA_SIGNING_SECRET: z.string().min(8).default('dev_media_signing_secret_change_me'),
    MEDIA_CDN_BASE_URL: z.string().url().optional(),

    VARIANT_MATRIX_MAX: z.coerce.number().int().min(1).max(5_000).default(200),
    IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(20_000),
    IMPORT_CHUNK_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
    CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    ADMIN_LIST_DEFAULT_LIMIT: z.coerce.number().int().min(1).max(200).default(25),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

    PRICING_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(120),
    PRICING_MAX_QUOTE_ITEMS: z.coerce.number().int().min(1).max(500).default(50),
    COUPON_CODE_LENGTH: z.coerce.number().int().min(4).max(32).default(10),
    PRICING_ENGINE_VERSION: z.coerce.number().int().min(1).max(1_000).default(2),

    // --- storefront search (Prompt 7) ---
    SEARCH_DRIVER: z.enum(SEARCH_DRIVERS).default('sql'),
    SEARCH_MIN_QUERY_LENGTH: z.coerce.number().int().min(1).max(10).default(2),
    SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(1_000).default(100),
    SEARCH_SUGGEST_LIMIT: z.coerce.number().int().min(1).max(50).default(8),
    SEARCH_INDEX_BATCH: z.coerce.number().int().min(1).max(5_000).default(200),
    SEARCH_TYPO_TOLERANCE: z.enum(['true', 'false']).default('true'),
    SEARCH_MEMO_MAX_DOCUMENTS: z.coerce.number().int().min(0).max(200_000).default(10_000),
    MEILI_HOST: z.string().url().optional(),
    MEILI_API_KEY: z.string().min(1).optional(),
    STOREFRONT_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(120),
    PRODUCT_VIEW_DEDUPE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(1_800),
    LISTING_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
    LISTING_RECONCILE_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),

    // --- cart, wishlist, addresses (Prompt 8) ---
    CART_COOKIE_NAME: z.string().min(1).max(40).default('cw_cart'),
    CART_COOKIE_SECRET: z.string().min(8).default('dev_cart_secret_change_me'),
    CART_GUEST_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
    CART_CUSTOMER_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).default(180),
    CART_ABANDON_AFTER_HOURS: z.coerce.number().int().min(1).max(8_760).default(6),
    CART_MAX_LINES: z.coerce.number().int().min(1).max(500).default(50),
    CART_MAX_QTY_PER_LINE: z.coerce.number().int().min(1).max(999).default(20),
    WISHLIST_MAX_LISTS: z.coerce.number().int().min(1).max(100).default(10),
    WISHLIST_MAX_ITEMS: z.coerce.number().int().min(1).max(5_000).default(200),
    ADDRESS_MAX_PER_CUSTOMER: z.coerce.number().int().min(1).max(200).default(20),
    RECENTLY_VIEWED_MAX: z.coerce.number().int().min(1).max(200).default(24),

    MAIL_DRIVER: z.enum(MAIL_DRIVERS).default('log'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).default('no-reply@clearwood.local'),

    PAYMENT_DRIVER: z.enum(PAYMENT_DRIVERS).default('mock'),
    /**
     * Razorpay is ON HOLD. `PAYMENT_DRIVER=razorpay` alone is refused: activating the live driver
     * takes this second, deliberate switch as well, so it cannot happen by copying one line.
     */
    RAZORPAY_ENABLED: z.enum(['true', 'false']).default('false'),
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    RAZORPAY_ACCOUNT_PRIMARY: z.string().min(1).optional(),
    RAZORPAY_ACCOUNT_SECONDARY: z.string().min(1).optional(),

    // --- orders, payments and the Route split (Prompt 9A) ---
    RAZORPAY_API_BASE: z.string().url().default('https://api.razorpay.com'),
    PAYMENT_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    PAYMENT_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    /** How long a PENDING_PAYMENT order keeps its stock and coupon holds. */
    CHECKOUT_HOLD_MINUTES: z.coerce.number().int().min(1).max(1_440).default(20),
    ORDER_NUMBER_PREFIX: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8)
      .regex(/^[A-Z]+$/)
      .default('CW'),
    COD_ENABLED: z.enum(['true', 'false']).default('true'),
    COD_MAX_ORDER_PAISE: z.coerce.number().int().min(0).default(5_000_000),
    COD_FEE_PAISE: z.coerce.number().int().min(0).default(0),
    SPLIT_ENABLED: z.enum(['true', 'false']).default('true'),
    SPLIT_ON_HOLD_DEFAULT: z.enum(['true', 'false']).default('false'),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    WEBHOOK_REPLAY_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10),
    /**
     * How long a refund execution lock may be held before reconciliation is allowed to reclaim it.
     * Only reconciliation may act on it: a user-facing override would let somebody clear a lock on
     * a refund that is still genuinely in flight.
     */
    REFUND_LOCK_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

    // --- fulfilment and shipping (Prompt 9B) ---
    /**
     * The driver used when no ShippingProvider row says otherwise.
     *
     * `manual` is the default deliberately: it is the only mode whose behaviour is fully verified
     * end to end, and admin-driven fulfilment is what a furniture business actually starts with.
     */
    SHIPPING_DRIVER: z.enum(SHIPPING_PROVIDER_DRIVERS).default('manual'),
    /**
     * The explicit assertion that a courier integration has been validated against a real sandbox.
     * Without it, production keeps Shiprocket inert (see `resolveShippingDriver`).
     */
    SHIPPING_PROVIDER_VERIFIED: z.enum(['true', 'false']).default('false'),
    SHIPROCKET_ENABLED: z.enum(['true', 'false']).default('false'),
    SHIPROCKET_EMAIL: z.string().min(1).optional(),
    SHIPROCKET_PASSWORD: z.string().min(1).optional(),
    /** The `x-api-key` Shiprocket echoes on webhook deliveries. */
    SHIPROCKET_WEBHOOK_TOKEN: z.string().min(1).optional(),
    SHIPROCKET_BASE_URL: z.string().url().default('https://apiv2.shiprocket.in/v1/external'),
    SHIPROCKET_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
    SHIPPING_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    SHIPPING_RETRY_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(500),
    SHIPMENT_NUMBER_PREFIX: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8)
      .regex(/^[A-Z]+$/)
      .default('CWS'),
    RETURN_NUMBER_PREFIX: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8)
      .regex(/^[A-Z]+$/)
      .default('CWR'),
    INVOICE_NUMBER_PREFIX: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8)
      .regex(/^[A-Z]+$/)
      .default('INV'),
    CREDIT_NOTE_PREFIX: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8)
      .regex(/^[A-Z]+$/)
      .default('CRN'),
    RETURN_WINDOW_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    /**
     * Customer-initiated returns.
     *
     * OFF by default: returns are an admin-operated process. A customer asks by phone or WhatsApp
     * and an admin raises the return in the console, which is how a furniture business with a
     * handful of returns a week actually works. The customer-facing endpoints exist and are tested,
     * but answer 404 until this is turned on — the feature does not exist for them, rather than
     * being forbidden.
     */
    FEATURE_CUSTOMER_RETURNS: z.enum(['true', 'false']).default('false'),
    NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('true'),

    CMS_MAX_BLOCKS_PER_PAGE: z.coerce.number().int().min(1).max(200).default(40),
    CMS_MAX_REVISIONS: z.coerce.number().int().min(1).max(500).default(30),
    CMS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    SITEMAP_PAGE_SIZE: z.coerce.number().int().min(100).max(50_000).default(5_000),
    SITEMAP_BASE_URL: z.string().min(1).default('http://localhost:7181'),
    CONTENT_VIEW_DEDUPE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

    WHATSAPP_NUMBER: z.string().min(1).default('919999999999'),
    SUPPORT_PHONE: z.string().min(1).default('+91 99999 99999'),
    SUPPORT_EMAIL: z.string().min(1).default('care@clearwood.local'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('debug'),

    /** Unset means "on in development, off everywhere else" — see `seedDemoEnabled`. */
    SEED_DEMO: z.enum(['true', 'false']).optional(),

    /** Unset means "on in development". Never honoured in production — see `queryCountDebug`. */
    DEBUG_QUERY_COUNT: z.enum(['true', 'false']).optional(),
  })
  .superRefine((value, ctx) => {
    const requireKey = (key: string, provided: unknown, because: string) => {
      if (provided === undefined || provided === null || provided === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `required ${because}` });
      }
    };

    if (value.CACHE_DRIVER === 'redis') {
      requireKey('REDIS_URL', value.REDIS_URL, 'when CACHE_DRIVER=redis');
    }

    if (value.SEARCH_DRIVER === 'meili') {
      requireKey('MEILI_HOST', value.MEILI_HOST, 'when SEARCH_DRIVER=meili');
      requireKey('MEILI_API_KEY', value.MEILI_API_KEY, 'when SEARCH_DRIVER=meili');
    }

    if (value.STORAGE_DRIVER === 's3') {
      requireKey('AWS_REGION', value.AWS_REGION, 'when STORAGE_DRIVER=s3');
      requireKey('AWS_ACCESS_KEY_ID', value.AWS_ACCESS_KEY_ID, 'when STORAGE_DRIVER=s3');
      requireKey('AWS_SECRET_ACCESS_KEY', value.AWS_SECRET_ACCESS_KEY, 'when STORAGE_DRIVER=s3');
      requireKey('S3_BUCKET', value.S3_BUCKET, 'when STORAGE_DRIVER=s3');
      requireKey('S3_PUBLIC_BASE_URL', value.S3_PUBLIC_BASE_URL, 'when STORAGE_DRIVER=s3');
    }
    if (value.MAIL_DRIVER === 'smtp') {
      requireKey('SMTP_HOST', value.SMTP_HOST, 'when MAIL_DRIVER=smtp');
      requireKey('SMTP_PORT', value.SMTP_PORT, 'when MAIL_DRIVER=smtp');
      requireKey('SMTP_USER', value.SMTP_USER, 'when MAIL_DRIVER=smtp');
      requireKey('SMTP_PASS', value.SMTP_PASS, 'when MAIL_DRIVER=smtp');
    }

    if (value.PAYMENT_DRIVER === 'razorpay' && value.RAZORPAY_ENABLED !== 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAZORPAY_ENABLED'],
        message:
          'Razorpay is ON HOLD. PAYMENT_DRIVER=razorpay also needs RAZORPAY_ENABLED=true, set deliberately once the account and keys are validated.',
      });
    }

    if (value.PAYMENT_DRIVER === 'razorpay') {
      requireKey('RAZORPAY_KEY_ID', value.RAZORPAY_KEY_ID, 'when PAYMENT_DRIVER=razorpay');
      requireKey('RAZORPAY_KEY_SECRET', value.RAZORPAY_KEY_SECRET, 'when PAYMENT_DRIVER=razorpay');
      requireKey(
        'RAZORPAY_WEBHOOK_SECRET',
        value.RAZORPAY_WEBHOOK_SECRET,
        'when PAYMENT_DRIVER=razorpay (webhook signature verification is mandatory)',
      );
      requireKey(
        'RAZORPAY_ACCOUNT_PRIMARY',
        value.RAZORPAY_ACCOUNT_PRIMARY,
        'when PAYMENT_DRIVER=razorpay',
      );

      // A live key never starts with the test prefix, and a dev placeholder is not a secret.
      if (value.NODE_ENV === 'production' && value.RAZORPAY_KEY_SECRET) {
        if (DEV_SECRETS.includes(value.RAZORPAY_KEY_SECRET)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['RAZORPAY_KEY_SECRET'],
            message: 'must not use the development default in production',
          });
        }
      }

      // Route needs somewhere to send the residue AND at least one partner to split with.
      if (value.SPLIT_ENABLED === 'true') {
        requireKey(
          'RAZORPAY_ACCOUNT_SECONDARY',
          value.RAZORPAY_ACCOUNT_SECONDARY,
          'when SPLIT_ENABLED=true — a split needs at least two accounts',
        );
      }
    }

    if (value.OTP_DRIVER === 'sms' || value.OTP_DRIVER === 'whatsapp') {
      requireKey('SMS_API_KEY', value.SMS_API_KEY, `when OTP_DRIVER=${value.OTP_DRIVER}`);
      requireKey('SMS_SENDER_ID', value.SMS_SENDER_ID, `when OTP_DRIVER=${value.OTP_DRIVER}`);
    }

    /*
     * Shiprocket is ON HOLD and its client is UNVERIFIED (its endpoint paths have never been tested
     * against a live account). A missing credential or a missing verification therefore leaves it
     * inert - `resolveShippingDriver` falls back to manual and says why at startup - instead of
     * refusing to boot: a half-configured courier must never take the catalog and admin down.
     */

    if (value.NODE_ENV === 'production') {
      const secretKeys = [
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'ADMIN_JWT_ACCESS_SECRET',
        'ADMIN_JWT_REFRESH_SECRET',
      ] as const;

      for (const key of secretKeys) {
        if (DEV_SECRETS.includes(value[key])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'must not use the development default in production',
          });
        } else if (value[key].length < MIN_PRODUCTION_SECRET_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
          });
        }
      }

      const secrets = secretKeys.map((key) => value[key]);
      if (new Set(secrets).size !== secrets.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_JWT_ACCESS_SECRET'],
          message: 'each realm needs its own access and refresh secret',
        });
      }

      if (value.ADMIN_SEED_PASSWORD === DEV_ADMIN_PASSWORD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_SEED_PASSWORD'],
          message: 'must be changed before running in production',
        });
      }

      // Also enforced from .env.example by productionSecrets; this copy holds without that file.
      if (value.ADMIN_SEED_EMAIL.trim().toLowerCase() === DEV_ADMIN_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_SEED_EMAIL'],
          message: 'must be a real address before running in production',
        });
      }

      if (value.AUTH_COOKIE_SECURE !== 'true') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_COOKIE_SECURE'],
          message: 'auth cookies must be Secure in production',
        });
      }

      if (value.MEDIA_SIGNING_SECRET === 'dev_media_signing_secret_change_me') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MEDIA_SIGNING_SECRET'],
          message: 'must not use the development default in production',
        });
      }

      if (value.CART_COOKIE_SECRET === 'dev_cart_secret_change_me') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CART_COOKIE_SECRET'],
          message: 'must not use the development default in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    console.error(
      [
        '',
        'Invalid environment configuration:',
        ...lines,
        '',
        'See backend/.env.example.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

// Production will not start while a secret is still the value shipped in .env.example.
assertProductionSecrets(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/** Whether `npm run db:seed` should also load the demo catalog (Prompt 2, step 07). */
export const seedDemoEnabled =
  env.SEED_DEMO === undefined ? env.NODE_ENV === 'development' : env.SEED_DEMO === 'true';

export const authCookieSecure = env.AUTH_COOKIE_SECURE === 'true';
export const csrfEnabled = env.CSRF_ENABLED === 'true';

/**
 * Per-request query counting. On by default in development, and FORCED OFF in production however
 * the variable is set: the counter holds the slowest statement's text, which can contain data, and
 * the response header would tell a caller about the shape of the database behind it.
 *
 * `nodeEnv` is the validated one; the flag is read raw so it can be flipped in a running dev
 * server without a restart, which is the whole point of a diagnostic.
 */
export function resolveQueryCountDebug(nodeEnv: string, flag: string | undefined): boolean {
  if (nodeEnv === 'production') return false;
  return flag === undefined ? nodeEnv === 'development' : flag === 'true';
}

export function queryCountDebug(): boolean {
  return resolveQueryCountDebug(env.NODE_ENV, process.env.DEBUG_QUERY_COUNT);
}

/** The OTP code is echoed in the response so the flow is testable without an SMS provider. */
export const otpDevCodeEnabled = env.NODE_ENV !== 'production';
export const avifEnabled = env.ENABLE_AVIF === 'true';
export const blurhashEnabled = env.GENERATE_BLURHASH === 'true';
export const typoToleranceEnabled = env.SEARCH_TYPO_TOLERANCE === 'true';
export const codEnabled = env.COD_ENABLED === 'true';
export const splitEnabled = env.SPLIT_ENABLED === 'true';
export const splitOnHoldByDefault = env.SPLIT_ON_HOLD_DEFAULT === 'true';
export const shiprocketEnabled = env.SHIPROCKET_ENABLED === 'true';
/** False means the courier integration has never been validated against a live account. */
export const shippingProviderVerified = env.SHIPPING_PROVIDER_VERIFIED === 'true';

type ShippingConfig = Pick<
  Env,
  | 'NODE_ENV'
  | 'SHIPPING_DRIVER'
  | 'SHIPROCKET_ENABLED'
  | 'SHIPPING_PROVIDER_VERIFIED'
  | 'SHIPROCKET_EMAIL'
  | 'SHIPROCKET_PASSWORD'
  | 'SHIPROCKET_WEBHOOK_TOKEN'
>;

/**
 * Shiprocket is ON HOLD. It may be reached - by the env default OR by a ShippingProvider row an
 * admin switched on - only when SHIPROCKET_ENABLED=true and, in production, when
 * SHIPPING_PROVIDER_VERIFIED=true as well.
 */
export function isShiprocketAllowed(value: ShippingConfig): boolean {
  if (value.SHIPROCKET_ENABLED !== 'true') return false;
  return value.NODE_ENV !== 'production' || value.SHIPPING_PROVIDER_VERIFIED === 'true';
}

/**
 * The default shipping driver that will actually run. An unusable Shiprocket selection falls back
 * to `manual` (the fully verified, admin-driven mode) and names the reason - key names only - so
 * startup can say it out loud instead of refusing to boot.
 */
export function resolveShippingDriver(value: ShippingConfig): {
  driver: Env['SHIPPING_DRIVER'];
  heldBack: string | null;
} {
  if (value.SHIPPING_DRIVER !== 'shiprocket') {
    return { driver: value.SHIPPING_DRIVER, heldBack: null };
  }

  if (value.SHIPROCKET_ENABLED !== 'true') {
    return { driver: 'manual', heldBack: 'SHIPROCKET_ENABLED is not true (Shiprocket is on hold)' };
  }
  if (!isShiprocketAllowed(value)) {
    return { driver: 'manual', heldBack: 'SHIPPING_PROVIDER_VERIFIED is not true in production' };
  }

  const missing = (
    ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_WEBHOOK_TOKEN'] as const
  ).filter((key) => !value[key]);

  if (missing.length > 0) {
    return { driver: 'manual', heldBack: `not configured: ${missing.join(', ')}` };
  }

  return { driver: 'shiprocket', heldBack: null };
}

export const shiprocketAllowed = isShiprocketAllowed(env);
export const effectiveShippingDriver = resolveShippingDriver(env).driver;

export const razorpayEnabled = env.RAZORPAY_ENABLED === 'true';

/**
 * Whether checkout may take an online payment at all.
 *
 * The mock driver signs with constants that are committed to this repository, so in production it
 * cannot vouch for anything: a forged signature would confirm an unpaid order. Until the real
 * provider is deliberately enabled, production offers cash on delivery only.
 */
export function resolveOnlinePayments(
  value: Pick<Env, 'NODE_ENV' | 'PAYMENT_DRIVER' | 'RAZORPAY_ENABLED'>,
): boolean {
  if (value.PAYMENT_DRIVER === 'razorpay') return value.RAZORPAY_ENABLED === 'true';
  return value.NODE_ENV !== 'production';
}

export const onlinePaymentsEnabled = resolveOnlinePayments(env);

export const notificationsEnabled = env.NOTIFICATIONS_ENABLED === 'true';
/** Customer-initiated returns. Off means returns are raised by an admin on the customer's behalf. */
export const customerReturnsEnabled = env.FEATURE_CUSTOMER_RETURNS === 'true';
export const maxUploadBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
export const allowedUploadMime = [
  ...env.ALLOWED_IMAGE_MIME,
  ...env.ALLOWED_VIDEO_MIME,
  ...env.ALLOWED_DOC_MIME,
];

/** Advertised by GET /api/v1/version and GET /ready. */
export const activeDrivers = {
  db: env.DATABASE_PROVIDER,
  cache: env.CACHE_DRIVER,
  storage: env.STORAGE_DRIVER,
  mail: env.MAIL_DRIVER,
  payment: env.PAYMENT_DRIVER,
  shipping: effectiveShippingDriver,
  otp: env.OTP_DRIVER,
  search: env.SEARCH_DRIVER,
} as const;
