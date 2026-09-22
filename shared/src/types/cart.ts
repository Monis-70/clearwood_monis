import type {
  AddressType,
  AddressUsage,
  CartEventType,
  CartIssueSeverity,
  CartItemState,
  CartStatus,
  CouponRejectionCode,
  MergeStrategy,
  SaveState,
  WishlistPriority,
} from '../enums';
import type { PriceBreakdown } from './pricing';
import type { ProductCardDto, ProductImageDto } from './storefront';

/**
 * Prompt 8 — cart, wishlist, addresses and recently-viewed.
 *
 * RULE 1: the cart never stores authoritative money. `breakdown` below is always a fresh
 * `PriceBreakdown` from the Prompt 6 engine; the `added*`/`last*` fields on a line are historical
 * snapshots used only to detect drift and rebuild history. Nothing displayed is derived from them.
 *
 * RULE 2: a line is identified by a deterministic `lineKey`
 * `sha256(productId | variantId ?? '' | sortedOptionValueIds | customizationHash ?? '')`,
 * so re-adding the same configuration increments qty instead of creating a second row.
 */

/* ------------------------------------------------------------------- cart */

export interface CartLineOptionDto {
  attributeId: string;
  attributeCode: string;
  attributeName: string;
  valueId: string;
  label: string;
  colorHex: string | null;
}

export interface CartLineDto {
  id: string;
  lineKey: string;
  productId: string;
  productSlug: string;
  variantId: string | null;
  sku: string;
  name: string;
  variantName: string | null;
  qty: number;
  saveState: SaveState;
  position: number;
  note: string | null;
  image: ProductImageDto | null;
  options: CartLineOptionDto[];

  /* Live money — every one of these comes from the fresh breakdown, never from the row. */
  unitPricePaise: number;
  listPricePaise: number | null;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  savingsPaise: number;

  /* Snapshots — historical only. */
  addedUnitPricePaise: number;
  lastUnitPricePaise: number | null;
  addedAt: string;

  availableQty: number;
  inStock: boolean;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  allowCustomization: boolean;
}

export interface PriceChangeDto {
  lineId: string;
  lineKey: string;
  productName: string;
  /** What the shopper saw when the line was added or last read. */
  previousUnitPricePaise: number;
  currentUnitPricePaise: number;
  deltaPaise: number;
  direction: 'UP' | 'DOWN';
  since: string;
}

export interface CartIssueDto {
  lineId: string | null;
  code: CartItemState | 'BELOW_MIN_ORDER_VALUE' | 'TOO_MANY_LINES' | 'COUPON_INVALID';
  severity: CartIssueSeverity;
  message: string;
  suggestedQty?: number;
  availableQty?: number;
  meta?: Record<string, unknown>;
}

export interface CartDeliveryLineDto {
  lineId: string;
  isServiceable: boolean;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  leadTimeDays: number | null;
}

export interface CartDeliveryDto {
  pincode: string | null;
  isServiceable: boolean;
  codAvailable: boolean;
  zoneName: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  lines: CartDeliveryLineDto[];
}

export interface CartCouponDto {
  code: string;
  applied: boolean;
  discountPaise: number;
  rejectionCode: CouponRejectionCode | null;
  message: string | null;
}

export interface CartDto {
  id: string;
  status: CartStatus;
  currency: 'INR';
  isGuest: boolean;
  itemCount: number;
  quantityTotal: number;
  lines: CartLineDto[];
  savedForLater: CartLineDto[];
  /** The single source of money truth — recomputed on every read. */
  breakdown: PriceBreakdown;
  coupon: CartCouponDto | null;
  delivery: CartDeliveryDto | null;
  priceChanges: PriceChangeDto[];
  issues: CartIssueDto[];
  isCheckoutReady: boolean;
  blockingCount: number;
  minOrderValuePaise: number;
  updatedAt: string;
  version: number;
}

export interface CartSummaryDto {
  itemCount: number;
  quantityTotal: number;
  grandTotalPaise: number;
  currency: 'INR';
}

export interface CartValidationDto {
  issues: CartIssueDto[];
  isCheckoutReady: boolean;
  blockingCount: number;
  /** Populated only when `autoFix=true`. */
  fixes: { lineId: string; action: 'CLAMPED' | 'REMOVED'; fromQty?: number; toQty?: number }[];
}

export interface CartMergeReportDto {
  merged: boolean;
  cartId: string;
  guestCartId: string | null;
  added: number;
  incremented: number;
  clamped: { lineKey: string; requestedQty: number; finalQty: number; reason: string }[];
  skipped: { lineKey: string; reason: string }[];
  couponOutcome: 'KEPT_CUSTOMER' | 'TOOK_GUEST' | 'DROPPED' | 'NONE';
  couponReason: string | null;
  wishlistItemsMoved: number;
  recentlyViewedMerged: number;
}

export interface CartEventDto {
  id: string;
  type: CartEventType;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/* --------------------------------------------------------------- wishlist */

export interface WishlistItemDto {
  id: string;
  lineKey: string;
  productId: string;
  variantId: string | null;
  priority: WishlistPriority;
  note: string | null;
  position: number;
  addedAt: string;
  addedPricePaise: number;
  currentPricePaise: number | null;
  /** True when the live price has fallen below what it cost when it was saved. */
  hasPriceDrop: boolean;
  priceDropPaise: number;
  product: ProductCardDto | null;
}

export interface WishlistDto {
  id: string;
  name: string;
  isDefault: boolean;
  isPublic: boolean;
  shareToken: string | null;
  itemCount: number;
  items: WishlistItemDto[];
  version: number;
}

/** Deliberately narrower than `WishlistDto` — a shared list leaks no customer identity. */
export interface SharedWishlistDto {
  name: string;
  itemCount: number;
  items: {
    productId: string;
    priority: WishlistPriority;
    note: string | null;
    product: ProductCardDto | null;
  }[];
}

/* ---------------------------------------------------------------- address */

export interface AddressDto {
  id: string;
  label: string | null;
  type: AddressType;
  usage: AddressUsage;
  fullName: string;
  phone: string;
  altPhone: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  country: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
  deliveryInstructions: string | null;
  isVerified: boolean;
  serviceability: PincodeLookupDto | null;
  version: number;
}

export interface PincodeLookupDto {
  pincode: string;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  isServiceable: boolean;
  codAvailable: boolean;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  zoneCode: string | null;
  zoneName: string | null;
  matchedBy: 'PINCODE' | 'RANGE' | 'DEFAULT' | 'NONE';
}

/* -------------------------------------------------------- recently viewed */

export interface RecentlyViewedDto {
  productId: string;
  variantId: string | null;
  viewedAt: string;
  viewCount: number;
  product: ProductCardDto | null;
}

/* ------------------------------------------------------------------ admin */

export interface AdminCartRowDto {
  id: string;
  status: CartStatus;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  isGuest: boolean;
  itemCount: number;
  quantityTotal: number;
  lastQuotedTotalPaise: number | null;
  couponCode: string | null;
  pincode: string | null;
  lastActivityAt: string;
  ageHours: number;
  createdAt: string;
}

export interface AdminCartDetailDto extends AdminCartRowDto {
  lines: CartLineDto[];
  /** A live re-quote, so support sees what the customer sees right now. */
  breakdown: PriceBreakdown | null;
  issues: CartIssueDto[];
  events: CartEventDto[];
  mergedIntoCartId: string | null;
  convertedOrderId: string | null;
}

export interface AdminCartStatsDto {
  totals: { active: number; abandoned: number; converted: number; merged: number; expired: number };
  abandonmentRateBp: number;
  averageValuePaise: number;
  activeValuePaise: number;
  topAbandonedProducts: {
    productId: string;
    name: string;
    sku: string;
    carts: number;
    quantity: number;
  }[];
}

export interface AdminWishlistStatsDto {
  mostWishlisted: { productId: string; name: string; sku: string; count: number }[];
  priceDropCandidates: {
    productId: string;
    name: string;
    addedPricePaise: number;
    currentPricePaise: number;
    dropPaise: number;
    watchers: number;
  }[];
  totals: { lists: number; items: number; publicLists: number };
}

export interface CartCleanupReportDto {
  abandoned: number;
  expired: number;
}

export type { MergeStrategy };
