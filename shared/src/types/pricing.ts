import type {
  CouponRejectionCode,
  CouponType,
  PriceComponentKind,
  PriceSourceType,
  PricingChannel,
  ShippingMethod,
} from '../enums';

/**
 * The price contract (Prompt 6).
 *
 * `PriceBreakdown` is what the PDP, listing, cart, checkout, order snapshot, invoice and the
 * Razorpay split all consume. It is produced by exactly one function — `pricingEngine.calculate` —
 * and its components always sum to `grandTotalPaise`. Prompt 9 stores the whole object with the
 * order, together with `engineVersion` and `contextHash`, so historical pricing stays explainable.
 */

export interface PriceComponent {
  /** Stable machine code, e.g. `BASE`, `ADJ_<id>`, `COUPON_WELCOME10`, `GST_18`. */
  code: string;
  label: string;
  kind: PriceComponentKind;
  /** Signed: discounts are negative, charges positive. */
  amountPaise: number;
  sourceType: PriceSourceType;
  sourceId?: string;
  meta?: Record<string, unknown>;
}

export interface TaxSplit {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface LineBreakdown {
  lineId: string;
  productId: string;
  variantId: string | null;
  qty: number;
  /** Before any rule: the variant price, or the product base when the variant inherits. */
  baseUnitPaise: number;
  /** After price list, tiers, adjustments and customisations — never negative. */
  unitPricePaise: number;
  /** MRP / compare-at, for the savings badge. */
  listPricePaise?: number;
  components: PriceComponent[];
  subtotalPaise: number;
  discountPaise: number;
  /** The amount GST is actually charged on. */
  taxablePaise: number;
  taxPaise: number;
  taxRateBp: number;
  taxSplit: TaxSplit;
  hsnCode?: string;
  totalPaise: number;
  savingsPaise: number;
  savingsPercentBp: number;
  isMadeToOrder: boolean;
  leadTimeDays?: number;
}

export interface PriceBreakdown {
  currency: 'INR';
  lines: LineBreakdown[];
  /** Cart-level components: cart discounts, coupon, shipping, rounding. */
  components: PriceComponent[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  taxSplit: TaxSplit;
  roundingPaise: number;
  grandTotalPaise: number;
  totalSavingsPaise: number;
  appliedCouponCode?: string;
  appliedRuleIds: string[];
  placeOfSupply: PlaceOfSupply;
  pricesIncludeTax: boolean;
  calculatedAt: string;
  engineVersion: number;
  contextHash: string;
}

export interface PlaceOfSupply {
  sellerStateCode: string;
  buyerStateCode: string;
  /** Same state -> CGST + SGST; different -> IGST. */
  isIntraState: boolean;
  /** True when the buyer state was unknown and the configured default was used. */
  isFallback: boolean;
}

/* ------------------------------------------------------------------ input */

export interface PriceRequestLine {
  lineId: string;
  productId: string;
  variantId?: string | null;
  /** Selected variant-defining and option values, used by ATTRIBUTE_VALUE-scoped rules. */
  optionValueIds?: string[];
  qty: number;
  /** Prompt 11 plugs configurator surcharges in here without touching the engine. */
  customizationAdjustments?: PriceComponent[];
}

export interface PriceRequest {
  lines: PriceRequestLine[];
  couponCode?: string;
  pincode?: string;
  channel?: PricingChannel;
  shippingMethod?: ShippingMethod;
  /** Engine is pure: the caller always supplies "now". */
  now: string;
}

/* --------------------------------------------------------------- settings */

export interface PricingSettings {
  pricesIncludeTax: boolean;
  sellerStateCode: string;
  defaultPlaceOfSupply: string;
  shippingTaxable: boolean;
  shippingTaxRateBp: number;
  roundTotalToRupee: boolean;
  freeShippingThresholdPaise: number;
  showSavingsBadge: boolean;
  minOrderValuePaise: number;
}

/* --------------------------------------------------------------- context */

export interface PricingCustomerGroup {
  id: string;
  code: string;
  name: string;
  priority: number;
  discountBp: number | null;
  /** The group every anonymous and ungrouped shopper is priced under. */
  isDefault?: boolean;
}

export interface PricingTaxClass {
  id: string;
  code: string;
  rateBp: number;
  hsnCode: string | null;
}

export interface PricingAdjustment {
  id: string;
  name: string;
  scope: string;
  adjustmentType: string;
  basis: string;
  priority: number;
  valuePaise: number | null;
  valueBp: number | null;
  categoryId: string | null;
  productId: string | null;
  variantId: string | null;
  attributeId: string | null;
  attributeValueId: string | null;
  customerGroupId: string | null;
  channel: string;
  minQty: number | null;
  maxQty: number | null;
  startsAt: string | null;
  endsAt: string | null;
  conditions: RuleConditionGroup | null;
}

export interface PricingTier {
  id: string;
  productId: string | null;
  variantId: string | null;
  customerGroupId: string | null;
  minQty: number;
  pricePaise: number | null;
  discountBp: number | null;
}

export interface PricingPriceListItem {
  id: string;
  priceListId: string;
  priceListCode: string;
  priceListPriority: number;
  productId: string | null;
  variantId: string | null;
  minQty: number;
  pricePaise: number;
}

export interface PricingCoupon {
  id: string;
  code: string;
  name: string;
  type: CouponType;
  valueBp: number | null;
  valuePaise: number | null;
  minSubtotalPaise: number | null;
  maxDiscountPaise: number | null;
  isStackable: boolean;
  isAutoApply: boolean;
  firstOrderOnly: boolean;
  appliesTo: CouponAppliesTo | null;
  termsText: string | null;
}

export interface CouponAppliesTo {
  productIds?: string[];
  variantIds?: string[];
  categoryIds?: string[];
  collectionIds?: string[];
  excludeProductIds?: string[];
  excludeCategoryIds?: string[];
  customerGroupIds?: string[];
}

export interface PricingDiscountRule {
  id: string;
  code: string;
  name: string;
  scope: string;
  priority: number;
  stopFurtherRules: boolean;
  conditions: RuleConditionGroup | null;
  actions: DiscountAction[];
}

export interface DiscountAction {
  type: 'PERCENT' | 'FIXED' | 'FREE_SHIPPING';
  valueBp?: number;
  valuePaise?: number;
  maxDiscountPaise?: number;
}

export interface RuleCondition {
  field: string;
  operator: string;
  value: string | number | boolean | string[] | number[];
}

export interface RuleConditionGroup {
  match: 'ALL' | 'ANY';
  conditions: RuleCondition[];
}

/** Everything one line needs, pre-loaded so the engine never touches the database. */
export interface PricingLineContext {
  lineId: string;
  productId: string;
  productName: string;
  productSlug: string;
  variantId: string | null;
  variantSku: string | null;
  baseUnitPaise: number;
  listPricePaise: number | null;
  /** The product's categories AND every ancestor, so CATEGORY rules inherit down the tree. */
  categoryIds: string[];
  collectionIds: string[];
  brandId: string | null;
  optionValueIds: string[];
  taxClass: PricingTaxClass;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  weightGrams: number | null;
  adjustments: PricingAdjustment[];
  tiers: PricingTier[];
  priceListItems: PricingPriceListItem[];
}

export interface PricingShippingRate {
  id: string;
  zoneId: string;
  zoneCode: string;
  method: ShippingMethod;
  name: string;
  conditionType: string;
  minValue: number | null;
  maxValue: number | null;
  basePaise: number;
  perUnitPaise: number | null;
  freeAbovePaise: number | null;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  priority: number;
}

export interface PricingContext {
  settings: PricingSettings;
  customerGroup: PricingCustomerGroup | null;
  customerId: string | null;
  isFirstOrder: boolean;
  channel: PricingChannel;
  buyerStateCode: string | null;
  pincode: string | null;
  lines: PricingLineContext[];
  coupon: PricingCoupon | null;
  autoCoupons: PricingCoupon[];
  discountRules: PricingDiscountRule[];
  shippingRates: PricingShippingRate[];
  /** Null when the pincode is unknown or not serviceable. */
  shippingZoneCode: string | null;
}

/* ----------------------------------------------------------------- output */

export interface CouponValidationResult {
  valid: boolean;
  code: string;
  rejectionCode?: CouponRejectionCode;
  message?: string;
  discountPaise?: number;
  freeShipping?: boolean;
}

export interface ServiceabilityResult {
  pincode: string;
  isServiceable: boolean;
  codAvailable: boolean;
  zoneCode: string | null;
  zoneName: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  matchedBy: 'PINCODE' | 'RANGE' | 'DEFAULT' | 'NONE';
}

/** One step of the admin simulator trace: every candidate rule and why it did or did not apply. */
export interface PricingTraceStep {
  step: string;
  ruleId: string | null;
  ruleName: string;
  matched: boolean;
  reason?: string;
  amountPaise?: number;
  runningUnitPaise?: number;
  runningTotalPaise?: number;
}

export interface PricingSimulation {
  breakdown: PriceBreakdown;
  trace: PricingTraceStep[];
}
