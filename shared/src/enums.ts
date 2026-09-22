/**
 * D2 — Prisma `enum` is forbidden (it does not survive a SQLite → MySQL move cleanly and cannot be
 * extended without a migration). Every "enum" in the system is a `String` column in the database
 * plus one of the const-unions below, which is the single source of truth for all three surfaces.
 */

type EnumObject<T extends readonly string[]> = Readonly<{ [K in T[number]]: K }>;

function enumFrom<const T extends readonly string[]>(values: T): EnumObject<T> {
  return Object.freeze(Object.fromEntries(values.map((v) => [v, v]))) as EnumObject<T>;
}

function guard<const T extends readonly string[]>(values: T) {
  return (value: unknown): value is T[number] =>
    typeof value === 'string' && (values as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ users */

export const USER_ROLES = ['CUSTOMER', 'STAFF', 'ADMIN', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const UserRole = enumFrom(USER_ROLES);
export const isUserRole = guard(USER_ROLES);

/* ----------------------------------------------------------------- orders */

/**
 * Prompt 9A drives DRAFT → PENDING_PAYMENT → CONFIRMED / PAYMENT_FAILED / EXPIRED / CANCELLED.
 * The fulfilment states exist in the state machine now but are only driven in 9B.
 */
export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PAYMENT_FAILED',
  'CONFIRMED',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'EXPIRED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OrderStatus = enumFrom(ORDER_STATUSES);
export const isOrderStatus = guard(ORDER_STATUSES);

export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'EXPIRED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PaymentStatus = enumFrom(PAYMENT_STATUSES);
export const isPaymentStatus = guard(PAYMENT_STATUSES);

export const FULFILLMENT_STATUSES = [
  'UNFULFILLED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'CANCELLED',
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];
export const FulfillmentStatus = enumFrom(FULFILLMENT_STATUSES);
export const isFulfillmentStatus = guard(FULFILLMENT_STATUSES);

export const PAYMENT_PROVIDERS = ['RAZORPAY', 'COD', 'MANUAL', 'WALLET'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const PaymentProvider = enumFrom(PAYMENT_PROVIDERS);
export const isPaymentProvider = guard(PAYMENT_PROVIDERS);

export const PAYMENT_METHOD_TYPES = [
  'CARD',
  'NETBANKING',
  'UPI',
  'WALLET',
  'EMI',
  'PAY_LATER',
  'COD',
  'MANUAL',
  'UNKNOWN',
] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];
export const PaymentMethodType = enumFrom(PAYMENT_METHOD_TYPES);
export const isPaymentMethodType = guard(PAYMENT_METHOD_TYPES);

export const TRANSFER_STATUSES = [
  'PENDING',
  'PROCESSED',
  'FAILED',
  'REVERSED',
  'PARTIALLY_REVERSED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const TransferStatus = enumFrom(TRANSFER_STATUSES);
export const isTransferStatus = guard(TRANSFER_STATUSES);

export const SETTLEMENT_STATUSES = ['PENDING', 'SETTLED', 'FAILED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const SettlementStatus = enumFrom(SETTLEMENT_STATUSES);
export const isSettlementStatus = guard(SETTLEMENT_STATUSES);

export const REFUND_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  /**
   * The provider call timed out or answered ambiguously, so we do NOT know whether the customer's
   * money moved. Treating that as FAILED invites a second refund; treating it as PROCESSED invites
   * a missing one. It is neither until reconciliation asks the provider.
   */
  'PENDING_VERIFICATION',
  'PROCESSED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const RefundStatus = enumFrom(REFUND_STATUSES);
export const isRefundStatus = guard(REFUND_STATUSES);

/**
 * How a provider failure must be treated.
 *
 * The distinction that matters is not "did it work" but "do we KNOW whether it worked". Only
 * UNKNOWN is dangerous, and it is the one most systems quietly mislabel as a failure.
 */
export const PROVIDER_OUTCOMES = [
  /** The provider considered the request and rejected it. Retrying changes nothing. */
  'TERMINAL',
  /** The request demonstrably never landed. Safe to retry automatically. */
  'RETRYABLE',
  /** Timeout, reset, ambiguous body. It may well have succeeded. Never retry blindly. */
  'UNKNOWN',
] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];
export const ProviderOutcome = enumFrom(PROVIDER_OUTCOMES);
export const isProviderOutcome = guard(PROVIDER_OUTCOMES);

export const REFUND_REASONS = [
  'CUSTOMER_REQUEST',
  'OUT_OF_STOCK',
  'DAMAGED',
  'WRONG_ITEM',
  'LATE_DELIVERY',
  'DUPLICATE_PAYMENT',
  'ORDER_CANCELLED',
  'PRICING_ERROR',
  'GOODWILL',
  'OTHER',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const RefundReason = enumFrom(REFUND_REASONS);
export const isRefundReason = guard(REFUND_REASONS);

export const WEBHOOK_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED',
  'DUPLICATE',
] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];
export const WebhookStatus = enumFrom(WEBHOOK_STATUSES);
export const isWebhookStatus = guard(WEBHOOK_STATUSES);

/** A hold on stock. Every RESERVED row has an expiry and an owner — see L5. */
export const RESERVATION_STATUSES = ['RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const ReservationStatus = enumFrom(RESERVATION_STATUSES);
export const isReservationStatus = guard(RESERVATION_STATUSES);

export const CHECKOUT_STEPS = ['CART', 'ADDRESS', 'REVIEW', 'PAYMENT', 'COMPLETE'] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];
export const CheckoutStep = enumFrom(CHECKOUT_STEPS);
export const isCheckoutStep = guard(CHECKOUT_STEPS);

export const ORDER_CHANNELS = ['WEB', 'MOBILE_WEB', 'ADMIN', 'PHONE', 'WHATSAPP'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];
export const OrderChannel = enumFrom(ORDER_CHANNELS);
export const isOrderChannel = guard(ORDER_CHANNELS);

/* ------------------------------------- fulfilment and shipping (P9B) */

/**
 * The shipment lifecycle. Deliberately ours, not any provider's — every carrier has its own
 * vocabulary and its own status ids, and mapping them all onto one internal set is what stops a
 * courier changing a label from breaking the order state machine.
 */
export const SHIPMENT_STATUSES = [
  'DRAFT',
  'READY',
  'AWB_ASSIGNED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'UNDELIVERED',
  'RTO_INITIATED',
  'RTO_DELIVERED',
  'CANCELLATION_REQUESTED',
  'CANCELLED',
  'LOST',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const ShipmentStatus = enumFrom(SHIPMENT_STATUSES);
export const isShipmentStatus = guard(SHIPMENT_STATUSES);

/** Forward to the customer, or reverse back to us. */
export const SHIPMENT_DIRECTIONS = ['FORWARD', 'REVERSE'] as const;
export type ShipmentDirection = (typeof SHIPMENT_DIRECTIONS)[number];
export const ShipmentDirection = enumFrom(SHIPMENT_DIRECTIONS);
export const isShipmentDirection = guard(SHIPMENT_DIRECTIONS);

/** Where a shipment event came from, so a provider claim is never mistaken for our own record. */
export const SHIPMENT_EVENT_SOURCES = ['SYSTEM', 'ADMIN', 'PROVIDER_WEBHOOK', 'PROVIDER_POLL'] as const;
export type ShipmentEventSource = (typeof SHIPMENT_EVENT_SOURCES)[number];
export const ShipmentEventSource = enumFrom(SHIPMENT_EVENT_SOURCES);
export const isShipmentEventSource = guard(SHIPMENT_EVENT_SOURCES);

export const SHIPPING_PROVIDER_DRIVERS = ['manual', 'mock', 'shiprocket'] as const;
export type ShippingProviderDriver = (typeof SHIPPING_PROVIDER_DRIVERS)[number];
export const ShippingProviderDriver = enumFrom(SHIPPING_PROVIDER_DRIVERS);
export const isShippingProviderDriver = guard(SHIPPING_PROVIDER_DRIVERS);

/** How a courier is picked when more than one can service the route. */
export const COURIER_STRATEGIES = [
  'MANUAL',
  'LOWEST_COST',
  'FASTEST',
  'ADMIN_PRIORITY',
  'COD_COMPATIBLE',
  'RETURN_COMPATIBLE',
] as const;
export type CourierStrategy = (typeof COURIER_STRATEGIES)[number];
export const CourierStrategy = enumFrom(COURIER_STRATEGIES);
export const isCourierStrategy = guard(COURIER_STRATEGIES);

export const PACKAGING_TYPES = ['BOX', 'CRATE', 'BAG', 'ROLL', 'FLAT_PACK', 'OTHER'] as const;
export type PackagingType = (typeof PACKAGING_TYPES)[number];
export const PackagingType = enumFrom(PACKAGING_TYPES);
export const isPackagingType = guard(PACKAGING_TYPES);

/** Every externally mutating provider call is journalled with one of these outcomes. */
export const PROVIDER_OPERATION_STATUSES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
] as const;
export type ProviderOperationStatus = (typeof PROVIDER_OPERATION_STATUSES)[number];
export const ProviderOperationStatus = enumFrom(PROVIDER_OPERATION_STATUSES);
export const isProviderOperationStatus = guard(PROVIDER_OPERATION_STATUSES);

/** Why a provider call failed, so the retry policy can tell "try again" from "never again". */
export const PROVIDER_FAILURE_KINDS = [
  'AUTHENTICATION',
  'VALIDATION',
  'RATE_LIMIT',
  'TIMEOUT',
  'TRANSPORT',
  'PROVIDER_CLIENT',
  'PROVIDER_SERVER',
  'UNSUPPORTED',
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];
export const ProviderFailureKind = enumFrom(PROVIDER_FAILURE_KINDS);
export const isProviderFailureKind = guard(PROVIDER_FAILURE_KINDS);

/* ------------------------------------------------- NDR (P9B) */

export const NDR_STATUSES = ['OPEN', 'ACTION_REQUESTED', 'RESOLVED', 'RTO', 'CLOSED'] as const;
export type NdrStatus = (typeof NDR_STATUSES)[number];
export const NdrStatus = enumFrom(NDR_STATUSES);
export const isNdrStatus = guard(NDR_STATUSES);

export const NDR_ACTIONS = ['REATTEMPT', 'RETURN', 'CONTACT_BUYER', 'FAKE_ATTEMPT'] as const;
export type NdrAction = (typeof NDR_ACTIONS)[number];
export const NdrAction = enumFrom(NDR_ACTIONS);
export const isNdrAction = guard(NDR_ACTIONS);

/** Nothing goes to RTO automatically unless an admin configured it to. */
export const NDR_POLICIES = ['MANUAL', 'AUTO_REATTEMPT', 'AUTO_RTO'] as const;
export type NdrPolicy = (typeof NDR_POLICIES)[number];
export const NdrPolicy = enumFrom(NDR_POLICIES);
export const isNdrPolicy = guard(NDR_POLICIES);

/* ---------------------------------------------- returns (P9B) */

export const RETURN_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PICKUP_SCHEDULED',
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const ReturnStatus = enumFrom(RETURN_STATUSES);
export const isReturnStatus = guard(RETURN_STATUSES);

export const RETURN_REASONS = [
  'DAMAGED_IN_TRANSIT',
  'DEFECTIVE',
  'WRONG_ITEM',
  'NOT_AS_DESCRIBED',
  'SIZE_OR_FIT',
  'CHANGED_MIND',
  'LATE_DELIVERY',
  'OTHER',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const ReturnReason = enumFrom(RETURN_REASONS);
export const isReturnReason = guard(RETURN_REASONS);

/** The inspection verdict, which is what decides whether a unit goes back on the shelf. */
export const RETURN_ITEM_CONDITIONS = [
  'PENDING',
  'RESELLABLE',
  'DAMAGED',
  'MISSING',
  'NOT_AS_DESCRIBED',
] as const;
export type ReturnItemCondition = (typeof RETURN_ITEM_CONDITIONS)[number];
export const ReturnItemCondition = enumFrom(RETURN_ITEM_CONDITIONS);
export const isReturnItemCondition = guard(RETURN_ITEM_CONDITIONS);

export const RETURN_RESOLUTIONS = ['REFUND', 'EXCHANGE', 'STORE_CREDIT', 'NONE'] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];
export const ReturnResolution = enumFrom(RETURN_RESOLUTIONS);
export const isReturnResolution = guard(RETURN_RESOLUTIONS);

/* ------------------------------------------- documents (P9B) */

/** ClearWood's own GST documents. A courier's label or invoice is NOT one of these. */
export const DOCUMENT_TYPES = [
  'TAX_INVOICE',
  'CREDIT_NOTE',
  'PACKING_SLIP',
  'SHIPPING_LABEL',
  'MANIFEST',
  'POD',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DocumentType = enumFrom(DOCUMENT_TYPES);
export const isDocumentType = guard(DOCUMENT_TYPES);

/* --------------------------------------- notifications (P9B) */

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationChannel = enumFrom(NOTIFICATION_CHANNELS);
export const isNotificationChannel = guard(NOTIFICATION_CHANNELS);

export const NOTIFICATION_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const NotificationStatus = enumFrom(NOTIFICATION_STATUSES);
export const isNotificationStatus = guard(NOTIFICATION_STATUSES);

/**
 * Only events the domain actually raises. Adding one here without raising it is a lie.
 *
 * The eight marked TEMPLATED are the order lifecycle a customer is told about, and each has a
 * seeded template. The rest are raised internally and deliberately have no template: nobody needs
 * an email because an AWB was allocated. The RETURN_* values stay while customer returns are
 * frozen (PROJECT_CONTEXT section 22) and are the first thing to template when the flag turns on.
 */
export const NOTIFICATION_EVENTS = [
  'ORDER_PLACED', // TEMPLATED
  'ORDER_CONFIRMED', // TEMPLATED
  'PAYMENT_FAILED', // TEMPLATED
  'ORDER_SHIPPED', // TEMPLATED
  'OUT_FOR_DELIVERY', // TEMPLATED
  'ORDER_DELIVERED', // TEMPLATED
  'ORDER_CANCELLED', // TEMPLATED
  'INVOICE_ISSUED', // TEMPLATED
  'SHIPMENT_CREATED',
  'AWB_ASSIGNED',
  'PICKUP_SCHEDULED',
  'IN_TRANSIT',
  'NDR_RAISED',
  'RTO_INITIATED',
  'RETURN_REQUESTED',
  'RETURN_APPROVED',
  'RETURN_PICKUP_SCHEDULED',
  'RETURN_IN_TRANSIT',
  'RETURN_RECEIVED',
  'REFUND_PROCESSED',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const NotificationEvent = enumFrom(NOTIFICATION_EVENTS);
export const isNotificationEvent = guard(NOTIFICATION_EVENTS);

/** The events with a seeded template. Dispatching any other event is a no-op with a SKIPPED log. */
export const TEMPLATED_NOTIFICATION_EVENTS = [
  'ORDER_PLACED',
  'ORDER_CONFIRMED',
  'PAYMENT_FAILED',
  'ORDER_SHIPPED',
  'OUT_FOR_DELIVERY',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'INVOICE_ISSUED',
] as const satisfies readonly NotificationEvent[];
export type TemplatedNotificationEvent = (typeof TEMPLATED_NOTIFICATION_EVENTS)[number];

/* -------------------------------------------- razorpay route split (P9) */

export const SPLIT_MODES = ['FIXED', 'PERCENT', 'REMAINDER'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];
export const SplitMode = enumFrom(SPLIT_MODES);
export const isSplitMode = guard(SPLIT_MODES);

export const SPLIT_SCOPES = ['GLOBAL', 'CATEGORY', 'PRODUCT', 'COLLECTION', 'BRAND'] as const;
export type SplitScope = (typeof SPLIT_SCOPES)[number];
export const SplitScope = enumFrom(SPLIT_SCOPES);
export const isSplitScope = guard(SPLIT_SCOPES);

/** Which number a rule's FIXED/PERCENT value is taken from. */
export const SPLIT_BASES = [
  'LINE_TOTAL',
  'LINE_SUBTOTAL',
  'ORDER_TOTAL',
  'ORDER_SUBTOTAL',
] as const;
export type SplitBasis = (typeof SPLIT_BASES)[number];
export const SplitBasis = enumFrom(SPLIT_BASES);
export const isSplitBasis = guard(SPLIT_BASES);

/* ---------------------------------------------------------------- drivers */

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];
export const StorageDriver = enumFrom(STORAGE_DRIVERS);
export const isStorageDriver = guard(STORAGE_DRIVERS);

export const CACHE_DRIVERS = ['memory', 'redis'] as const;
export type CacheDriver = (typeof CACHE_DRIVERS)[number];
export const CacheDriver = enumFrom(CACHE_DRIVERS);
export const isCacheDriver = guard(CACHE_DRIVERS);

export const MAIL_DRIVERS = ['log', 'smtp'] as const;
export type MailDriver = (typeof MAIL_DRIVERS)[number];
export const MailDriver = enumFrom(MAIL_DRIVERS);
export const isMailDriver = guard(MAIL_DRIVERS);

export const PAYMENT_DRIVERS = ['mock', 'razorpay'] as const;
export type PaymentDriver = (typeof PAYMENT_DRIVERS)[number];
export const PaymentDriver = enumFrom(PAYMENT_DRIVERS);
export const isPaymentDriver = guard(PAYMENT_DRIVERS);

export const DATABASE_PROVIDERS = ['sqlite', 'mysql'] as const;
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];
export const DatabaseProvider = enumFrom(DATABASE_PROVIDERS);
export const isDatabaseProvider = guard(DATABASE_PROVIDERS);

/* --------------------------------------------------------------- settings */

/** D3 — keeps `AppSetting.value` a plain String column while staying typed. */
export const SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];
export const SettingValueType = enumFrom(SETTING_VALUE_TYPES);
export const isSettingValueType = guard(SETTING_VALUE_TYPES);

/* --------------------------------------------------------------- auditing */

/** Prompt 1 named this `AuditActorType`; from Prompt 3 the same values are `PrincipalType`. */
export const AUDIT_ACTOR_TYPES = ['ADMIN_USER', 'CUSTOMER', 'SYSTEM'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const AuditActorType = enumFrom(AUDIT_ACTOR_TYPES);
export const isAuditActorType = guard(AUDIT_ACTOR_TYPES);

/* ------------------------------------------------------------ sort/order */

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const SortOrder = enumFrom(SORT_ORDERS);
export const isSortOrder = guard(SORT_ORDERS);

/* ---------------------------------------------------------------- catalog */

export const CATEGORY_KINDS = [
  'STANDARD',
  'ALL',
  'SPECIAL_COLLECTION',
  'MAKE_YOUR_OWN',
  'NEW_ARRIVALS',
  'INTERIOR_SOLUTION',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const CategoryKind = enumFrom(CATEGORY_KINDS);
export const isCategoryKind = guard(CATEGORY_KINDS);

export const PRODUCT_TYPES = [
  'SIMPLE',
  'VARIABLE',
  'CONFIGURABLE',
  'MADE_TO_ORDER',
  'BUNDLE',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const ProductType = enumFrom(PRODUCT_TYPES);
export const isProductType = guard(PRODUCT_TYPES);

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const ProductStatus = enumFrom(PRODUCT_STATUSES);
export const isProductStatus = guard(PRODUCT_STATUSES);

export const VISIBILITIES = ['PUBLIC', 'HIDDEN', 'SEARCH_ONLY', 'CATALOG_ONLY'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const Visibility = enumFrom(VISIBILITIES);
export const isVisibility = guard(VISIBILITIES);

export const STOCK_STATUSES = [
  'IN_STOCK',
  'LOW_STOCK',
  'OUT_OF_STOCK',
  'PREORDER',
  'MADE_TO_ORDER',
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];
export const StockStatus = enumFrom(STOCK_STATUSES);
export const isStockStatus = guard(STOCK_STATUSES);

/* ------------------------------------------------------------- attributes */

export const ATTRIBUTE_INPUTS = [
  'SELECT',
  'MULTISELECT',
  'SWATCH_COLOR',
  'SWATCH_IMAGE',
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'BOOLEAN',
] as const;
export type AttributeInput = (typeof ATTRIBUTE_INPUTS)[number];
export const AttributeInput = enumFrom(ATTRIBUTE_INPUTS);
export const isAttributeInput = guard(ATTRIBUTE_INPUTS);

export const ATTRIBUTE_DATA_TYPES = ['STRING', 'NUMBER', 'BOOLEAN'] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];
export const AttributeDataType = enumFrom(ATTRIBUTE_DATA_TYPES);
export const isAttributeDataType = guard(ATTRIBUTE_DATA_TYPES);

/* ------------------------------------------------------------------ media */

export const MEDIA_KINDS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MediaKind = enumFrom(MEDIA_KINDS);
export const isMediaKind = guard(MEDIA_KINDS);

export const MEDIA_ROLES = [
  'PRIMARY',
  'HOVER',
  'GALLERY',
  'LIFESTYLE',
  'DIMENSION_SHEET',
  'VIDEO',
  'THREE_SIXTY',
] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];
export const MediaRole = enumFrom(MEDIA_ROLES);
export const isMediaRole = guard(MEDIA_ROLES);

export const DEVICE_TARGETS = ['ALL', 'MOBILE', 'DESKTOP'] as const;
export type DeviceTarget = (typeof DEVICE_TARGETS)[number];
export const DeviceTarget = enumFrom(DEVICE_TARGETS);
export const isDeviceTarget = guard(DEVICE_TARGETS);

export const MEDIA_STATUSES = [
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
  'QUARANTINED',
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export const MediaStatus = enumFrom(MEDIA_STATUSES);
export const isMediaStatus = guard(MEDIA_STATUSES);

export const RENDITION_LABELS = [
  'THUMB',
  'SMALL',
  'MEDIUM',
  'LARGE',
  'XLARGE',
  'MOBILE',
  'DESKTOP',
  'SQUARE',
  'ORIGINAL',
] as const;
export type RenditionLabel = (typeof RENDITION_LABELS)[number];
export const RenditionLabel = enumFrom(RENDITION_LABELS);
export const isRenditionLabel = guard(RENDITION_LABELS);

export const IMAGE_FORMATS = ['JPEG', 'PNG', 'WEBP', 'AVIF', 'SVG', 'GIF'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export const ImageFormat = enumFrom(IMAGE_FORMATS);
export const isImageFormat = guard(IMAGE_FORMATS);

/** Every place a Media row can be referenced from. MediaUsage is the single source of truth. */
export const MEDIA_USAGE_TYPES = [
  'PRODUCT',
  'PRODUCT_VARIANT',
  'CATEGORY_ICON',
  'CATEGORY_BANNER',
  'CATEGORY_MOBILE_BANNER',
  'COLLECTION_BANNER',
  'BRAND_LOGO',
  'ATTRIBUTE_SWATCH',
  'ADMIN_AVATAR',
  'CUSTOMER_AVATAR',
  'CMS_BANNER',
  'CMS_PAGE',
  'FAQ',
  'OTHER',
] as const;
export type MediaUsageType = (typeof MEDIA_USAGE_TYPES)[number];
export const MediaUsageType = enumFrom(MEDIA_USAGE_TYPES);
export const isMediaUsageType = guard(MEDIA_USAGE_TYPES);

export const MEDIA_SOURCES = ['ADMIN_UPLOAD', 'SEED', 'IMPORT', 'SYSTEM'] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];
export const MediaSource = enumFrom(MEDIA_SOURCES);
export const isMediaSource = guard(MEDIA_SOURCES);

/* ------------------------------------------------------------- collections */

export const COLLECTION_TYPES = ['MANUAL', 'AUTOMATIC'] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];
export const CollectionType = enumFrom(COLLECTION_TYPES);
export const isCollectionType = guard(COLLECTION_TYPES);

/* -------------------------------------------------------- price adjustments */

// CUSTOMIZATION has no FK yet — Prompt 11 adds PriceAdjustment.customizationChoiceId.
export const PRICE_ADJUSTMENT_SCOPES = [
  'GLOBAL',
  'CATEGORY',
  'PRODUCT',
  'VARIANT',
  'ATTRIBUTE_VALUE',
  'CUSTOMIZATION',
] as const;
export type PriceAdjustmentScope = (typeof PRICE_ADJUSTMENT_SCOPES)[number];
export const PriceAdjustmentScope = enumFrom(PRICE_ADJUSTMENT_SCOPES);
export const isPriceAdjustmentScope = guard(PRICE_ADJUSTMENT_SCOPES);

export const PRICE_ADJUSTMENT_TYPES = [
  'FIXED_AMOUNT',
  'PERCENT',
  'PER_UNIT',
  'MULTIPLIER',
] as const;
export type PriceAdjustmentType = (typeof PRICE_ADJUSTMENT_TYPES)[number];
export const PriceAdjustmentType = enumFrom(PRICE_ADJUSTMENT_TYPES);
export const isPriceAdjustmentType = guard(PRICE_ADJUSTMENT_TYPES);

export const PRICE_ADJUSTMENT_BASES = ['BASE', 'RUNNING_SUBTOTAL'] as const;
export type PriceAdjustmentBasis = (typeof PRICE_ADJUSTMENT_BASES)[number];
export const PriceAdjustmentBasis = enumFrom(PRICE_ADJUSTMENT_BASES);
export const isPriceAdjustmentBasis = guard(PRICE_ADJUSTMENT_BASES);

/* ------------------------------------------------------------- navigation */

export const NAVIGATION_ITEM_TYPES = [
  'CATEGORY',
  'COLLECTION',
  'URL',
  'LEAD_FORM',
  'PAGE',
] as const;
export type NavigationItemType = (typeof NAVIGATION_ITEM_TYPES)[number];
export const NavigationItemType = enumFrom(NAVIGATION_ITEM_TYPES);
export const isNavigationItemType = guard(NAVIGATION_ITEM_TYPES);

export const NAVIGATION_MENU_KEYS = [
  'MAIN',
  'FOOTER_PRIMARY',
  'FOOTER_SECONDARY',
  'MOBILE',
  'TOP_BAR',
] as const;
export type NavigationMenuKey = (typeof NAVIGATION_MENU_KEYS)[number];
export const NavigationMenuKey = enumFrom(NAVIGATION_MENU_KEYS);
export const isNavigationMenuKey = guard(NAVIGATION_MENU_KEYS);

/* -------------------------------------------------------- admin catalog (P5) */

export const BULK_ACTION_TYPES = [
  'ACTIVATE',
  'DEACTIVATE',
  'PUBLISH',
  'UNPUBLISH',
  'DELETE',
  'RESTORE',
  'MOVE_CATEGORY',
  'ASSIGN_COLLECTION',
  'SET_TAX_CLASS',
  'SET_BRAND',
  'ADJUST_STOCK',
] as const;
export type BulkActionType = (typeof BULK_ACTION_TYPES)[number];
export const BulkActionType = enumFrom(BULK_ACTION_TYPES);
export const isBulkActionType = guard(BULK_ACTION_TYPES);

export const IMPORT_ENTITIES = [
  'PRODUCT',
  'VARIANT',
  'CATEGORY',
  'ATTRIBUTE_VALUE',
  'PRICE_ADJUSTMENT',
  'INVENTORY',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export const ImportEntity = enumFrom(IMPORT_ENTITIES);
export const isImportEntity = guard(IMPORT_ENTITIES);

export const IMPORT_STATUSES = [
  'PENDING',
  'VALIDATING',
  'VALIDATED',
  'FAILED_VALIDATION',
  'IMPORTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const ImportStatus = enumFrom(IMPORT_STATUSES);
export const isImportStatus = guard(IMPORT_STATUSES);

/** Why stock moved. ORDER_* reasons are written by Prompt 9, never by an admin. */
export const INVENTORY_REASONS = [
  'MANUAL_ADJUSTMENT',
  'INITIAL_STOCK',
  'PURCHASE',
  'PRODUCTION',
  'RETURN',
  'DAMAGE',
  'CORRECTION',
  'ORDER_RESERVED',
  'ORDER_RELEASED',
  'ORDER_FULFILLED',
  'CANCELLATION',
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];
export const InventoryReason = enumFrom(INVENTORY_REASONS);
export const isInventoryReason = guard(INVENTORY_REASONS);

export const PRODUCT_RELATION_TYPES = [
  'CROSS_SELL',
  'UPSELL',
  'SIMILAR',
  'FREQUENTLY_BOUGHT',
  'BUNDLE_ITEM',
  'VARIANT_OF_STYLE',
] as const;
export type ProductRelationType = (typeof PRODUCT_RELATION_TYPES)[number];
export const ProductRelationType = enumFrom(PRODUCT_RELATION_TYPES);
export const isProductRelationType = guard(PRODUCT_RELATION_TYPES);

export const SLUG_ENTITY_TYPES = ['PRODUCT', 'CATEGORY', 'COLLECTION', 'PAGE'] as const;
export type SlugEntityType = (typeof SLUG_ENTITY_TYPES)[number];
export const SlugEntityType = enumFrom(SLUG_ENTITY_TYPES);
export const isSlugEntityType = guard(SLUG_ENTITY_TYPES);

/** What a delete does when the row still has dependants. */
export const DELETE_STRATEGIES = ['BLOCK', 'SOFT', 'REASSIGN_CHILDREN', 'CASCADE_SOFT'] as const;
export type DeleteStrategy = (typeof DELETE_STRATEGIES)[number];
export const DeleteStrategy = enumFrom(DELETE_STRATEGIES);
export const isDeleteStrategy = guard(DELETE_STRATEGIES);

/* ------------------------------------------------------------ pricing (P6) */

/** Sales channel a price rule applies to. `ALL` matches every channel. */
export const PRICING_CHANNELS = ['ALL', 'WEB', 'APP', 'STORE', 'B2B'] as const;
export type PricingChannel = (typeof PRICING_CHANNELS)[number];
export const PricingChannel = enumFrom(PRICING_CHANNELS);
export const isPricingChannel = guard(PRICING_CHANNELS);

/** Every line of a price breakdown is one of these. They sum to the grand total, always. */
export const PRICE_COMPONENT_KINDS = [
  'BASE',
  'ADJUSTMENT',
  'DISCOUNT',
  'COUPON',
  'SHIPPING',
  'TAX',
  'ROUNDING',
] as const;
export type PriceComponentKind = (typeof PRICE_COMPONENT_KINDS)[number];
export const PriceComponentKind = enumFrom(PRICE_COMPONENT_KINDS);
export const isPriceComponentKind = guard(PRICE_COMPONENT_KINDS);

/** Where a component came from, so a breakdown can always be explained. */
export const PRICE_SOURCE_TYPES = [
  'BASE_PRICE',
  'VARIANT_PRICE',
  'PRICE_LIST',
  'TIER_PRICE',
  'PRICE_ADJUSTMENT',
  'CUSTOMIZATION',
  'DISCOUNT_RULE',
  'COUPON',
  'SHIPPING_RATE',
  'TAX_CLASS',
  'ROUNDING',
] as const;
export type PriceSourceType = (typeof PRICE_SOURCE_TYPES)[number];
export const PriceSourceType = enumFrom(PRICE_SOURCE_TYPES);
export const isPriceSourceType = guard(PRICE_SOURCE_TYPES);

export const COUPON_TYPES = ['PERCENT', 'FIXED', 'FREE_SHIPPING', 'TIERED'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export const CouponType = enumFrom(COUPON_TYPES);
export const isCouponType = guard(COUPON_TYPES);

/** Why a coupon was refused. The storefront maps these to copy; never invent a new string. */
export const COUPON_REJECTION_CODES = [
  'COUPON_NOT_FOUND',
  'EXPIRED',
  'NOT_STARTED',
  'INACTIVE',
  'USAGE_LIMIT_REACHED',
  'CUSTOMER_LIMIT_REACHED',
  'MIN_SUBTOTAL_NOT_MET',
  'NOT_APPLICABLE_TO_ITEMS',
  'CUSTOMER_GROUP_NOT_ELIGIBLE',
  'FIRST_ORDER_ONLY',
  'NOT_STACKABLE',
] as const;
export type CouponRejectionCode = (typeof COUPON_REJECTION_CODES)[number];
export const CouponRejectionCode = enumFrom(COUPON_REJECTION_CODES);
export const isCouponRejectionCode = guard(COUPON_REJECTION_CODES);

/** Two-phase redemption: reserve at checkout, confirm on payment, release on failure. */
export const REDEMPTION_STATUSES = ['RESERVED', 'CONFIRMED', 'RELEASED'] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];
export const RedemptionStatus = enumFrom(REDEMPTION_STATUSES);
export const isRedemptionStatus = guard(REDEMPTION_STATUSES);

export const DISCOUNT_RULE_SCOPES = ['LINE', 'CART'] as const;
export type DiscountRuleScope = (typeof DISCOUNT_RULE_SCOPES)[number];
export const DiscountRuleScope = enumFrom(DISCOUNT_RULE_SCOPES);
export const isDiscountRuleScope = guard(DISCOUNT_RULE_SCOPES);

export const SHIPPING_METHODS = ['STANDARD', 'EXPRESS', 'WHITE_GLOVE', 'SELF_PICKUP'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];
export const ShippingMethod = enumFrom(SHIPPING_METHODS);
export const isShippingMethod = guard(SHIPPING_METHODS);

export const SHIPPING_CONDITION_TYPES = ['PRICE', 'WEIGHT', 'ITEM_COUNT'] as const;
export type ShippingConditionType = (typeof SHIPPING_CONDITION_TYPES)[number];
export const ShippingConditionType = enumFrom(SHIPPING_CONDITION_TYPES);
export const isShippingConditionType = guard(SHIPPING_CONDITION_TYPES);

/** The ONLY operators the price-rule condition evaluator understands. No eval, ever. */
export const CONDITION_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_OR_EQUAL',
  'LESS_THAN',
  'LESS_OR_EQUAL',
  'IN',
  'NOT_IN',
  'CONTAINS',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const ConditionOperator = enumFrom(CONDITION_OPERATORS);
export const isConditionOperator = guard(CONDITION_OPERATORS);

/** The only facts a condition may read. Anything else is rejected at validation time. */
export const CONDITION_FIELDS = [
  'qty',
  'unitPricePaise',
  'lineSubtotalPaise',
  'cartSubtotalPaise',
  'cartItemCount',
  'productId',
  'variantId',
  'categoryId',
  'collectionId',
  'brandId',
  'attributeValueId',
  'customerGroupCode',
  'channel',
  'pincode',
  'isFirstOrder',
  'weekday',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const ConditionField = enumFrom(CONDITION_FIELDS);
export const isConditionField = guard(CONDITION_FIELDS);

/* --------------------------------------------------- storefront search (P7) */

export const SEARCH_DRIVERS = ['sql', 'meili'] as const;
export type SearchDriverName = (typeof SEARCH_DRIVERS)[number];
export const SearchDriverName = enumFrom(SEARCH_DRIVERS);
export const isSearchDriverName = guard(SEARCH_DRIVERS);

/** What a SearchDocument describes. One index, four entity families. */
export const SEARCH_ENTITY_TYPES = [
  'PRODUCT',
  'CATEGORY',
  'COLLECTION',
  'BRAND',
  'PAGE',
  'HELP_ARTICLE',
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];
export const SearchEntityType = enumFrom(SEARCH_ENTITY_TYPES);
export const isSearchEntityType = guard(SEARCH_ENTITY_TYPES);

export const SEARCH_INDEX_JOB_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type SearchIndexJobStatus = (typeof SEARCH_INDEX_JOB_STATUSES)[number];
export const SearchIndexJobStatus = enumFrom(SEARCH_INDEX_JOB_STATUSES);
export const isSearchIndexJobStatus = guard(SEARCH_INDEX_JOB_STATUSES);

/** `RELEVANCE` is only valid together with `q`; everything else works on any listing. */
export const PRODUCT_SORTS = [
  'RELEVANCE',
  'PRICE_ASC',
  'PRICE_DESC',
  'NEWEST',
  'POPULARITY',
  'BEST_SELLING',
  'RATING',
  'NAME_ASC',
  'CURATED',
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const ProductSort = enumFrom(PRODUCT_SORTS);
export const isProductSort = guard(PRODUCT_SORTS);

/**
 * Filtering and sorting always run against the DEFAULT customer group's indexed price range;
 * a row's displayed price may be personalised. Every list response states which basis it used.
 */
export const PRICING_BASES = ['DEFAULT_GROUP', 'CUSTOMER_GROUP'] as const;
export type PricingBasisKind = (typeof PRICING_BASES)[number];
export const PricingBasisKind = enumFrom(PRICING_BASES);
export const isPricingBasisKind = guard(PRICING_BASES);

export const FACET_KINDS = [
  'ATTRIBUTE',
  'BRAND',
  'PRICE',
  'AVAILABILITY',
  'RATING',
  'FLAG',
] as const;
export type FacetKind = (typeof FACET_KINDS)[number];
export const FacetKind = enumFrom(FACET_KINDS);
export const isFacetKind = guard(FACET_KINDS);

export const SUGGESTION_TYPES = [
  'PRODUCT',
  'CATEGORY',
  'COLLECTION',
  'BRAND',
  'PAGE',
  'HELP_ARTICLE',
  'QUERY',
] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];
export const SuggestionType = enumFrom(SUGGESTION_TYPES);
export const isSuggestionType = guard(SUGGESTION_TYPES);

/** What GET /catalog/resolve decided about a path. */
export const RESOLVE_RESULT_TYPES = [
  'PRODUCT',
  'CATEGORY',
  'COLLECTION',
  'PAGE',
  'REDIRECT',
  'NOT_FOUND',
] as const;
export type ResolveResultType = (typeof RESOLVE_RESULT_TYPES)[number];
export const ResolveResultType = enumFrom(RESOLVE_RESULT_TYPES);
export const isResolveResultType = guard(RESOLVE_RESULT_TYPES);

/**
 * The ONLY fields an AUTOMATIC collection rule may read (Prompt 5 stores them, Prompt 7 evaluates
 * them). Extending this list is the only way to widen the DSL.
 */
export const COLLECTION_RULE_FIELDS = [
  'categoryId',
  'categoryPath',
  'brandId',
  'taxClassId',
  'basePricePaise',
  'compareAtPricePaise',
  'attributeValueId',
  'productType',
  'searchKeywords',
  'createdAt',
  'isFeatured',
  'isNewArrival',
  'isBestSeller',
  'isSpecialCollection',
  'isMadeToOrder',
  'soldCount',
  'ratingAvgBp',
  'tags',
  'stockStatus',
] as const;
export type CollectionRuleField = (typeof COLLECTION_RULE_FIELDS)[number];
export const CollectionRuleField = enumFrom(COLLECTION_RULE_FIELDS);
export const isCollectionRuleField = guard(COLLECTION_RULE_FIELDS);

/** Compiled to a Prisma `where` object — never to SQL text and never to JavaScript. */
export const COLLECTION_RULE_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_OR_EQUAL',
  'LESS_THAN',
  'LESS_OR_EQUAL',
  'BETWEEN',
  'CONTAINS',
  'STARTS_WITH',
  'IN',
  'NOT_IN',
] as const;
export type CollectionRuleOperator = (typeof COLLECTION_RULE_OPERATORS)[number];
export const CollectionRuleOperator = enumFrom(COLLECTION_RULE_OPERATORS);
export const isCollectionRuleOperator = guard(COLLECTION_RULE_OPERATORS);

export const RULE_MATCH_MODES = ['ALL', 'ANY'] as const;
export type RuleMatchMode = (typeof RULE_MATCH_MODES)[number];
export const RuleMatchMode = enumFrom(RULE_MATCH_MODES);
export const isRuleMatchMode = guard(RULE_MATCH_MODES);

/* ------------------------------------------- cart, wishlist, address (P8) */

/** A cart is MERGED into another, CONVERTED to an order, or aged out. It is never deleted. */
export const CART_STATUSES = ['ACTIVE', 'MERGED', 'CONVERTED', 'ABANDONED', 'EXPIRED'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];
export const CartStatus = enumFrom(CART_STATUSES);
export const isCartStatus = guard(CART_STATUSES);

/** What is wrong with a cart line. The storefront maps these to copy; never invent a new string. */
export const CART_ITEM_STATES = [
  'OK',
  'PRICE_CHANGED',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'BELOW_MIN_QTY',
  'ABOVE_MAX_QTY',
  'UNAVAILABLE',
  'NOT_SERVICEABLE',
  'MADE_TO_ORDER',
] as const;
export type CartItemState = (typeof CART_ITEM_STATES)[number];
export const CartItemState = enumFrom(CART_ITEM_STATES);
export const isCartItemState = guard(CART_ITEM_STATES);

/** BLOCKING is the only severity that stops checkout. */
export const CART_ISSUE_SEVERITIES = ['INFO', 'WARNING', 'BLOCKING'] as const;
export type CartIssueSeverity = (typeof CART_ISSUE_SEVERITIES)[number];
export const CartIssueSeverity = enumFrom(CART_ISSUE_SEVERITIES);
export const isCartIssueSeverity = guard(CART_ISSUE_SEVERITIES);

export const SAVE_STATES = ['IN_CART', 'SAVED_FOR_LATER'] as const;
export type SaveState = (typeof SAVE_STATES)[number];
export const SaveState = enumFrom(SAVE_STATES);
export const isSaveState = guard(SAVE_STATES);

export const ADDRESS_TYPES = ['HOME', 'OFFICE', 'OTHER'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];
export const AddressType = enumFrom(ADDRESS_TYPES);
export const isAddressType = guard(ADDRESS_TYPES);

export const ADDRESS_USAGES = ['SHIPPING', 'BILLING', 'BOTH'] as const;
export type AddressUsage = (typeof ADDRESS_USAGES)[number];
export const AddressUsage = enumFrom(ADDRESS_USAGES);
export const isAddressUsage = guard(ADDRESS_USAGES);

export const WISHLIST_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type WishlistPriority = (typeof WISHLIST_PRIORITIES)[number];
export const WishlistPriority = enumFrom(WISHLIST_PRIORITIES);
export const isWishlistPriority = guard(WISHLIST_PRIORITIES);

/** How a guest cart is folded into a signed-in customer's cart. */
export const MERGE_STRATEGIES = [
  'SUM_QUANTITIES',
  'KEEP_HIGHEST',
  'GUEST_WINS',
  'CUSTOMER_WINS',
] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];
export const MergeStrategy = enumFrom(MERGE_STRATEGIES);
export const isMergeStrategy = guard(MERGE_STRATEGIES);

/** Lightweight cart audit trail; feeds the admin abandoned-cart view. */
export const CART_EVENT_TYPES = [
  'CREATED',
  'ITEM_ADDED',
  'ITEM_UPDATED',
  'ITEM_REMOVED',
  'SAVED_FOR_LATER',
  'MOVED_TO_CART',
  'MOVED_TO_WISHLIST',
  'CLEARED',
  'COUPON_APPLIED',
  'COUPON_REMOVED',
  'COUPON_DROPPED',
  'PINCODE_SET',
  'MERGED_IN',
  'MERGED_OUT',
  'AUTO_FIXED',
  'ABANDONED',
  'EXPIRED',
  'CONVERTED',
] as const;
export type CartEventType = (typeof CART_EVENT_TYPES)[number];
export const CartEventType = enumFrom(CART_EVENT_TYPES);
export const isCartEventType = guard(CART_EVENT_TYPES);

/* ------------------------------------------------------------------- auth */

/**
 * Two independent realms sharing one implementation. Different secrets, audiences and cookie names
 * mean an admin token can never authenticate a storefront request, and vice-versa.
 */
export const AUTH_REALMS = ['ADMIN', 'CUSTOMER'] as const;
export type AuthRealm = (typeof AUTH_REALMS)[number];
export const AuthRealm = enumFrom(AUTH_REALMS);
export const isAuthRealm = guard(AUTH_REALMS);

/** SYSTEM is the actor for seeds and background jobs. */
export const PRINCIPAL_TYPES = ['ADMIN_USER', 'CUSTOMER', 'SYSTEM'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
export const PrincipalType = enumFrom(PRINCIPAL_TYPES);
export const isPrincipalType = guard(PRINCIPAL_TYPES);

export const ADMIN_ROLE_CODES = [
  'SUPER_ADMIN',
  'ADMIN',
  'CATALOG_MANAGER',
  'ORDER_MANAGER',
  'CONTENT_MANAGER',
] as const;
export type AdminRoleCode = (typeof ADMIN_ROLE_CODES)[number];
export const AdminRoleCode = enumFrom(ADMIN_ROLE_CODES);
export const isAdminRoleCode = guard(ADMIN_ROLE_CODES);

export const ADMIN_USER_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'DISABLED'] as const;
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];
export const AdminUserStatus = enumFrom(ADMIN_USER_STATUSES);
export const isAdminUserStatus = guard(ADMIN_USER_STATUSES);

export const CUSTOMER_STATUSES = ['ACTIVE', 'GUEST', 'BLOCKED', 'PENDING_VERIFICATION'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const CustomerStatus = enumFrom(CUSTOMER_STATUSES);
export const isCustomerStatus = guard(CUSTOMER_STATUSES);

export const OTP_PURPOSES = [
  'LOGIN',
  'SIGNUP',
  'PHONE_VERIFY',
  'PASSWORD_RESET',
  'ORDER_CONFIRM',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
export const OtpPurpose = enumFrom(OTP_PURPOSES);
export const isOtpPurpose = guard(OTP_PURPOSES);

export const OTP_CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];
export const OtpChannel = enumFrom(OTP_CHANNELS);
export const isOtpChannel = guard(OTP_CHANNELS);

export const OTP_DRIVERS = ['log', 'sms', 'whatsapp'] as const;
export type OtpDriver = (typeof OTP_DRIVERS)[number];
export const OtpDriver = enumFrom(OTP_DRIVERS);
export const isOtpDriver = guard(OTP_DRIVERS);

export const TOKEN_PURPOSES = ['PASSWORD_RESET', 'EMAIL_VERIFY', 'ADMIN_INVITE'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];
export const TokenPurpose = enumFrom(TOKEN_PURPOSES);
export const isTokenPurpose = guard(TOKEN_PURPOSES);

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGE',
  'PASSWORD_RESET',
  'ROLE_ASSIGNED',
  'ROLE_REVOKED',
  'PERMISSION_DENIED',
  'SESSION_REVOKED',
  'TOKEN_REUSE_DETECTED',
  'SETTING_CHANGED',
  'EXPORT',
  'IMPORT',
  'PUBLISH',
  'UNPUBLISH',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AuditAction = enumFrom(AUDIT_ACTIONS);
export const isAuditAction = guard(AUDIT_ACTIONS);

export const AUDIT_SEVERITIES = ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export const AuditSeverity = enumFrom(AUDIT_SEVERITIES);
export const isAuditSeverity = guard(AUDIT_SEVERITIES);

/* ------------------------------------------------------- permission registry */

/**
 * `group.resource.action`. Guards reference these codes; the rows themselves are seeded, so a new
 * permission is a seed change, never an `if (user.role === ...)` in a guard.
 */
export const PERMISSION_CODES = [
  'catalog.category.read',
  'catalog.category.create',
  'catalog.category.update',
  'catalog.category.delete',
  'catalog.category.reorder',
  'catalog.attribute.read',
  'catalog.attribute.create',
  'catalog.attribute.update',
  'catalog.attribute.delete',
  'catalog.product.read',
  'catalog.product.create',
  'catalog.product.update',
  'catalog.product.delete',
  'catalog.product.publish',
  'catalog.product.import',
  'catalog.product.export',
  'catalog.variant.read',
  'catalog.variant.create',
  'catalog.variant.update',
  'catalog.variant.delete',
  'catalog.collection.read',
  'catalog.collection.create',
  'catalog.collection.update',
  'catalog.collection.delete',
  'catalog.inventory.read',
  'catalog.inventory.update',
  'pricing.adjustment.read',
  'pricing.adjustment.create',
  'pricing.adjustment.update',
  'pricing.adjustment.delete',
  'pricing.tax.read',
  'pricing.tax.update',
  'pricing.coupon.read',
  'pricing.coupon.create',
  'pricing.coupon.update',
  'pricing.coupon.delete',
  'media.asset.read',
  'media.asset.upload',
  'media.asset.update',
  'media.asset.delete',
  'order.order.read',
  'order.order.update',
  'order.order.cancel',
  'order.order.fulfil',
  'order.order.export',
  'order.refund.read',
  'order.refund.create',
  'order.refund.approve',
  'order.customer.read',
  'order.customer.update',
  'order.customer.block',
  'order.customer.export',
  'payment.settings.read',
  'payment.settings.update',
  'payment.split.read',
  'payment.split.update',
  'cms.page.read',
  'cms.page.create',
  'cms.page.update',
  'cms.page.delete',
  'cms.banner.read',
  'cms.banner.create',
  'cms.banner.update',
  'cms.banner.delete',
  'cms.navigation.read',
  'cms.navigation.update',
  'cms.faq.read',
  'cms.faq.create',
  'cms.faq.update',
  'cms.faq.delete',
  'lead.enquiry.read',
  'lead.enquiry.update',
  'lead.enquiry.assign',
  'lead.enquiry.export',
  'system.user.read',
  'system.user.create',
  'system.user.update',
  'system.user.delete',
  'system.role.read',
  'system.role.create',
  'system.role.update',
  'system.role.delete',
  'system.setting.read',
  'system.setting.update',
  'system.audit.read',
  'system.audit.export',
] as const;

export type Permission = (typeof PERMISSION_CODES)[number];
export const isPermission = guard(PERMISSION_CODES);

/** Flagged in the UI and always worth an audit row with raised severity. */
export function isDangerousPermission(code: string): boolean {
  return (
    code.startsWith('system.role.') ||
    code === 'system.user.delete' ||
    code.startsWith('payment.') ||
    code.endsWith('.export') ||
    code === 'order.refund.approve'
  );
}

export function permissionGroup(code: string): string {
  return code.split('.')[0] ?? 'other';
}

/* ------------------------------------------------------------- CMS (P10A) */

export const PAGE_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];
export const PageStatus = enumFrom(PAGE_STATUSES);
export const isPageStatus = guard(PAGE_STATUSES);

export const PAGE_TYPES = [
  'STANDARD',
  'LANDING',
  'POLICY',
  'HOME',
  'CATEGORY_LANDING',
  'HELP',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];
export const PageType = enumFrom(PAGE_TYPES);
export const isPageType = guard(PAGE_TYPES);

/**
 * The block vocabulary. Every value here MUST have an entry in `cms/blockRegistry.ts`; a test
 * iterates this list and fails if one is missing, so the enum and the registry cannot drift.
 */
export const BLOCK_TYPES = [
  'HERO_SLIDER',
  'CATEGORY_CIRCLES',
  'FEATURED_COLLECTION',
  'PRODUCT_GRID',
  'PRODUCT_CAROUSEL',
  'BANNER_SPLIT',
  'BANNER_FULL',
  'COUNTDOWN_DEAL',
  'USP_STRIP',
  'RICH_TEXT',
  'IMAGE_WITH_TEXT',
  'VIDEO_EMBED',
  'TESTIMONIALS',
  'FAQ_ACCORDION',
  'TRUST_BADGES',
  'STORE_LOCATOR',
  'NEWSLETTER_SIGNUP',
  'LEAD_FORM_CTA',
  'INSTAGRAM_GRID',
  'BRAND_STRIP',
  'SPACER',
  'CUSTOM_HTML',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const BlockType = enumFrom(BLOCK_TYPES);
export const isBlockType = guard(BLOCK_TYPES);

export const BLOCK_CATEGORIES = ['HERO', 'COMMERCE', 'CONTENT', 'SOCIAL', 'LAYOUT'] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];
export const BlockCategory = enumFrom(BLOCK_CATEGORIES);

export const BANNER_PLACEMENTS = [
  'HOME_HERO',
  'HOME_STRIP',
  'CATEGORY_TOP',
  'PDP_SIDEBAR',
  'CART_PROMO',
  'CHECKOUT',
  'ANNOUNCEMENT_BAR',
  'POPUP',
  'FOOTER',
] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
export const BannerPlacement = enumFrom(BANNER_PLACEMENTS);
export const isBannerPlacement = guard(BANNER_PLACEMENTS);

export const FAQ_VISIBILITIES = [
  'GLOBAL',
  'PRODUCT',
  'CATEGORY',
  'ORDER',
  'SHIPPING',
  'PAYMENT',
  'WARRANTY',
  'CARE',
] as const;
export type FaqVisibility = (typeof FAQ_VISIBILITIES)[number];
export const FaqVisibility = enumFrom(FAQ_VISIBILITIES);
export const isFaqVisibility = guard(FAQ_VISIBILITIES);

export const CONTENT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export const ContentStatus = enumFrom(CONTENT_STATUSES);
export const isContentStatus = guard(CONTENT_STATUSES);

export const DEVICE_VISIBILITIES = ['ALL', 'DESKTOP_ONLY', 'MOBILE_ONLY'] as const;
export type DeviceVisibility = (typeof DEVICE_VISIBILITIES)[number];
export const DeviceVisibility = enumFrom(DEVICE_VISIBILITIES);
export const isDeviceVisibility = guard(DEVICE_VISIBILITIES);

/** What a caller says it is, so the renderer can drop blocks the device will never show. */
export const DEVICE_KINDS = ['DESKTOP', 'MOBILE'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DeviceKind = enumFrom(DEVICE_KINDS);
export const isDeviceKind = guard(DEVICE_KINDS);
