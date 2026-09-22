/**
 * Columns whose comparison must be case-SENSITIVE, and the reason the list exists.
 *
 * The database and every table default to `utf8mb4_unicode_ci`, which is case-INSENSITIVE. That is
 * right for anything a human types - an email, a slug, a coupon code - and wrong for anything
 * generated. Two hashes differing only in case are two different hashes, and a case-insensitive
 * UNIQUE index on one can reject a legitimate value or, worse, treat two distinct opaque
 * identifiers as the same row.
 *
 * `utf8mb4_bin` is deliberate over `utf8mb4_0900_as_cs`: the latter is case-sensitive but still
 * applies Unicode normalisation, and normalising a digest is exactly the class of surprise this
 * list exists to prevent. `_bin` compares bytes and nothing else.
 *
 * PRISMA CANNOT EXPRESS THIS. There is no column-level collation attribute in the schema language,
 * so `schema.prisma` is silent about it and a future `prisma migrate dev` may propose reverting it.
 * `tests/collation.test.ts` reads this list and asserts the live database still agrees, which is
 * the control for that regression. Rename a column here and the guard fails loudly.
 *
 * `id` columns are deliberately ABSENT. All 93 foreign keys target an id, and both sides of a
 * foreign key must share a collation.
 */

export interface CaseSensitiveColumn {
  table: string;
  column: string;
  why: string;
}

export const CASE_SENSITIVE_COLUMNS: CaseSensitiveColumn[] = [
  // --- digests: a hash that folds case is not a hash ---
  { table: 'RefreshToken', column: 'tokenHash', why: 'session token digest, unique' },
  { table: 'VerificationToken', column: 'tokenHash', why: 'verification token digest, unique' },
  { table: 'OtpChallenge', column: 'codeHash', why: 'OTP digest' },
  { table: 'IdempotencyKey', column: 'requestHash', why: 'request body digest' },
  { table: 'Media', column: 'checksum', why: 'content digest used for deduplication' },
  { table: 'OrderDocument', column: 'checksum', why: 'digest of the stored GST document' },
  { table: 'SearchDocument', column: 'checksum', why: 'index freshness digest' },
  { table: 'Cart', column: 'lastQuoteContextHash', why: 'pricing context digest' },
  { table: 'CartItem', column: 'customizationHash', why: 'line identity digest' },
  { table: 'OrderItem', column: 'customizationHash', why: 'line identity digest' },
  { table: 'Order', column: 'pricingContextHash', why: 'pricing context digest' },
  { table: 'CheckoutSession', column: 'quoteHash', why: 'quote digest' },
  { table: 'SplitAllocation', column: 'computedAtHash', why: 'split determinism digest' },

  // --- credentials and signatures ---
  { table: 'AdminUser', column: 'passwordHash', why: 'argon2 hash' },
  { table: 'Customer', column: 'passwordHash', why: 'argon2 hash' },
  { table: 'AdminUser', column: 'twoFactorSecret', why: 'base32 TOTP secret' },
  { table: 'Payment', column: 'providerSignature', why: 'webhook HMAC' },

  // --- identifiers issued by a third party: their case is not ours to fold ---
  { table: 'Payment', column: 'providerPaymentId', why: 'Razorpay payment id, unique' },
  { table: 'Payment', column: 'providerOrderId', why: 'Razorpay order id' },
  { table: 'Refund', column: 'providerRefundId', why: 'Razorpay refund id, unique' },
  { table: 'WebhookEvent', column: 'providerEventId', why: 'webhook dedupe key' },
  { table: 'PaymentTransfer', column: 'providerTransferId', why: 'Route transfer id, unique' },
  { table: 'PaymentTransfer', column: 'providerRecipientId', why: 'Route recipient id' },
  { table: 'TransferReversal', column: 'providerReversalId', why: 'Route reversal id, unique' },
  { table: 'Settlement', column: 'providerSettlementId', why: 'settlement id, unique' },
  { table: 'SplitAccount', column: 'providerAccountId', why: 'linked account id' },
  { table: 'Shipment', column: 'providerShipmentId', why: 'courier shipment id' },
  { table: 'Shipment', column: 'providerOrderId', why: 'courier order id' },
  { table: 'Shipment', column: 'providerCourierId', why: 'courier id' },
  { table: 'NdrRecord', column: 'providerNdrId', why: 'courier NDR id' },
  { table: 'PickupLocation', column: 'providerLocationId', why: 'courier location id' },

  // --- idempotency keys: supplied by a caller, compared for exact replay ---
  { table: 'IdempotencyKey', column: 'key', why: 'caller-supplied replay key' },
  { table: 'Payment', column: 'idempotencyKey', why: 'payment replay key' },
  { table: 'ProviderOperation', column: 'idempotencyKey', why: 'provider replay key, unique' },

  // --- opaque values we generate, where a case collision is a security defect ---
  { table: 'Cart', column: 'activeOwnerKey', why: 'derived owner key, unique - one cart per owner' },
  { table: 'Cart', column: 'sessionId', why: 'guest session identity; a fold could cross carts' },
  { table: 'CheckoutSession', column: 'sessionId', why: 'guest session identity' },
  { table: 'Wishlist', column: 'sessionId', why: 'guest session identity' },
  { table: 'RecentlyViewed', column: 'sessionId', why: 'guest session identity' },
  { table: 'SearchQueryLog', column: 'sessionId', why: 'guest session identity' },
  { table: 'Wishlist', column: 'shareToken', why: 'public share token, unique' },
  { table: 'OrderDocument', column: 'storageKey', why: 'S3 object key - S3 keys are case-sensitive' },
  { table: 'Shipment', column: 'awbNumber', why: 'carrier air waybill number' },
  { table: 'Shipment', column: 'pickupTokenNumber', why: 'carrier pickup token' },
  { table: 'Settlement', column: 'utr', why: 'bank UTR' },
];

export const CASE_SENSITIVE_COLLATION = 'utf8mb4_bin';

/**
 * Columns the heuristic flags as opaque but which are deliberately left case-INSENSITIVE.
 *
 * The register above can only be checked against itself: it cannot notice a NEW column that should
 * have been added to it. `tests/collation.test.ts` therefore re-runs the classifier over
 * schema.prisma and fails on anything it flags that appears in neither list. This is that second
 * list - a decision recorded as data rather than as prose, so the next column named `*Key` forces
 * someone to choose rather than silently defaulting.
 */
export const CASE_INSENSITIVE_BY_DECISION: CaseSensitiveColumn[] = [
  { table: 'AppSetting', column: 'key', why: 'authored by a human; folding case prevents two settings differing only in case' },
  { table: 'NavigationMenu', column: 'key', why: 'authored by a human ("main", "footer")' },
  { table: 'ShippingProviderConfig', column: 'key', why: 'authored by a human' },
  { table: 'SplitAccount', column: 'key', why: 'authored by an admin' },
  { table: 'DocumentSequence', column: 'key', why: 'internal series name, compared exactly and never user-supplied' },
  { table: 'OrderSequence', column: 'key', why: 'internal series name' },
  { table: 'AuditLog', column: 'requestId', why: 'log correlation only; never unique, never a decision' },
  { table: 'Media', column: 'blurhash', why: 'display data; never compared or indexed' },
  { table: 'Shipment', column: 'providerCourierName', why: 'a display name, not an identifier' },
  { table: 'Shipment', column: 'providerMetadataJson', why: 'a LongText blob; never compared' },
  { table: 'Shipment', column: 'providerCode', why: 'enum-like driver code we normalise ourselves' },
  { table: 'Shipment', column: 'providerStatus', why: 'courier status text, diagnostics only' },
  { table: 'Shipment', column: 'providerStatusCode', why: 'courier status code, diagnostics only' },
  { table: 'ShipmentEvent', column: 'providerStatus', why: 'courier status text, diagnostics only' },
  { table: 'ShipmentEvent', column: 'providerStatusCode', why: 'courier status code, diagnostics only' },
  { table: 'ProviderOperation', column: 'providerCode', why: 'enum-like driver code we normalise ourselves' },
];
