import { createHash } from 'node:crypto';

import {
  allocateProportionally,
  applyBasisPoints,
  rupeeRoundingAdjustment,
  savingsPercentBp,
  splitGst,
  taxFromInclusive,
} from '@shared/money';
import type {
  LineBreakdown,
  PriceBreakdown,
  PriceComponent,
  PriceRequest,
  PriceRequestLine,
  PricingContext,
  PricingCoupon,
  PricingLineContext,
  PricingTraceStep,
  TaxSplit,
} from '@shared/types/pricing';

import { matchAdjustments } from './adjustment.matcher';
import type { ConditionFacts } from './condition.evaluator';
import { evaluateConditionGroup } from './condition.evaluator';
import { resolvePriceList, resolveTier } from './tier.resolver';

/**
 * THE price calculation. Pure: no Prisma, no cache, no I/O, no Date.now().
 *
 * Everything it needs arrives in `PricingContext` (loaded by pricingContext.loader.ts) and `now`
 * arrives in the request, which is what makes a breakdown replayable — Prompt 9 can re-run a stored
 * context months later and get byte-identical numbers.
 *
 * Calculation order (fixed, documented in PROJECT_CONTEXT §15):
 *   1 base unit           variant price, or the product base when the variant inherits
 *   2 price list          an active list REPLACES the base
 *   3 tier                highest minQty <= qty wins; price replaces, discountBp reduces
 *   4 adjustments         priority, then scope specificity, then id
 *   5 customisation       components supplied by the caller (Prompt 11)
 *   6 customer group      the group's blanket discountBp, once, on the running unit price
 *   7 unit price          floored at 0; line subtotal = unit x qty
 *   7 line discounts      auto rules, then the coupon
 *   8 cart level          cart discounts and coupons allocated back proportionally
 *   9 shipping            zone rate, free-above threshold, FREE_SHIPPING coupons
 *  10 tax                 GST per line, inclusive or exclusive, CGST+SGST or IGST
 *  11 rounding            whole-rupee adjustment when enabled
 *  12 invariant           components must sum to the grand total, or we throw
 */

export const ENGINE_VERSION_DEFAULT = 2;

export class PricingInvariantError extends Error {
  readonly code = 'PRICING_INVARIANT_VIOLATION';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PricingInvariantError';
  }
}

export interface CalculateOptions {
  engineVersion?: number;
  /** The simulator asks for a trace; the storefront does not pay for one. */
  collectTrace?: boolean;
}

export interface CalculateResult {
  breakdown: PriceBreakdown;
  trace: PricingTraceStep[];
}

const ZERO_SPLIT: TaxSplit = { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };

function sumComponents(components: PriceComponent[]): number {
  return components.reduce((total, component) => total + component.amountPaise, 0);
}

function addSplit(a: TaxSplit, b: TaxSplit): TaxSplit {
  return {
    cgstPaise: a.cgstPaise + b.cgstPaise,
    sgstPaise: a.sgstPaise + b.sgstPaise,
    igstPaise: a.igstPaise + b.igstPaise,
  };
}

/** A stable fingerprint of everything that influenced the result. */
export function hashContext(context: PricingContext, request: PriceRequest): string {
  const payload = JSON.stringify({
    settings: context.settings,
    customerGroup: context.customerGroup?.id ?? null,
    // Only when set, so every context without a group discount keeps its existing hash.
    ...(context.customerGroup?.discountBp
      ? { customerGroupDiscountBp: context.customerGroup.discountBp }
      : {}),
    channel: context.channel,
    buyerStateCode: context.buyerStateCode,
    pincode: context.pincode,
    isFirstOrder: context.isFirstOrder,
    shippingZoneCode: context.shippingZoneCode,
    coupon: context.coupon?.id ?? null,
    autoCoupons: context.autoCoupons.map((coupon) => coupon.id),
    discountRules: context.discountRules.map((rule) => rule.id),
    shippingRates: context.shippingRates.map((rate) => rate.id),
    lines: context.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      baseUnitPaise: line.baseUnitPaise,
      optionValueIds: [...line.optionValueIds].sort(),
      taxClass: line.taxClass.id,
      adjustments: line.adjustments.map((adjustment) => adjustment.id),
      tiers: line.tiers.map((tier) => tier.id),
      priceListItems: line.priceListItems.map((item) => item.id),
    })),
    request: {
      lines: request.lines.map((line) => ({
        lineId: line.lineId,
        qty: line.qty,
        customization: line.customizationAdjustments ?? [],
      })),
      couponCode: request.couponCode ?? null,
      shippingMethod: request.shippingMethod ?? null,
      now: request.now,
    },
  });

  return createHash('sha256').update(payload).digest('hex');
}

function buildFacts(
  line: PricingLineContext,
  qty: number,
  unitPricePaise: number,
  context: PricingContext,
  cartSubtotalPaise: number,
  cartItemCount: number,
  now: Date,
): ConditionFacts {
  return {
    qty,
    unitPricePaise,
    lineSubtotalPaise: unitPricePaise * qty,
    cartSubtotalPaise,
    cartItemCount,
    productId: line.productId,
    variantId: line.variantId,
    categoryId: line.categoryIds,
    collectionId: line.collectionIds,
    brandId: line.brandId,
    attributeValueId: line.optionValueIds,
    customerGroupCode: context.customerGroup?.code ?? null,
    channel: context.channel,
    pincode: context.pincode,
    isFirstOrder: context.isFirstOrder,
    weekday: now.getUTCDay(),
  };
}

/* ------------------------------------------------------------ steps 1 – 6 */

interface UnitResult {
  components: PriceComponent[];
  unitPricePaise: number;
  baseUnitPaise: number;
  trace: PricingTraceStep[];
}

function resolveUnitPrice(
  line: PricingLineContext,
  requestLine: PriceRequestLine,
  context: PricingContext,
  now: Date,
  cartSubtotalEstimate: number,
  cartItemCount: number,
): UnitResult {
  const qty = requestLine.qty;
  const components: PriceComponent[] = [];
  const trace: PricingTraceStep[] = [];

  // 1 — base
  let base = line.baseUnitPaise;
  components.push({
    code: 'BASE',
    label: line.variantSku ? `${line.productName} (${line.variantSku})` : line.productName,
    kind: 'BASE',
    amountPaise: base,
    sourceType: line.variantId ? 'VARIANT_PRICE' : 'BASE_PRICE',
    sourceId: line.variantId ?? line.productId,
  });
  trace.push({
    step: 'base',
    ruleId: null,
    ruleName: 'Base price',
    matched: true,
    runningUnitPaise: base,
  });

  // 2 — price list REPLACES the base
  const priceList = resolvePriceList(line, qty);
  if (priceList) {
    const delta = priceList.pricePaise - base;
    base = priceList.pricePaise;
    components.push({
      code: `PRICE_LIST_${priceList.item.priceListCode}`,
      label: `Price list ${priceList.item.priceListCode}`,
      kind: 'ADJUSTMENT',
      amountPaise: delta,
      sourceType: 'PRICE_LIST',
      sourceId: priceList.item.priceListId,
      meta: { replacedBasePaise: priceList.pricePaise },
    });
    trace.push({
      step: 'priceList',
      ruleId: priceList.item.priceListId,
      ruleName: `Price list ${priceList.item.priceListCode}`,
      matched: true,
      amountPaise: delta,
      runningUnitPaise: base,
    });
  }

  // 3 — tier: replaces (pricePaise) or discounts (discountBp) the current base
  const tier = resolveTier(line, qty, context.customerGroup?.id ?? null, base);
  if (tier) {
    base = tier.pricePaise;
    components.push({
      code: `TIER_${tier.tier.minQty}`,
      label: `Quantity ${tier.tier.minQty}+ price`,
      kind: 'ADJUSTMENT',
      amountPaise: tier.deltaPaise,
      sourceType: 'TIER_PRICE',
      sourceId: tier.tier.id,
      meta: {
        minQty: tier.tier.minQty,
        mode: tier.tier.pricePaise !== null ? 'REPLACE' : 'DISCOUNT_BP',
      },
    });
    trace.push({
      step: 'tier',
      ruleId: tier.tier.id,
      ruleName: `Tier from qty ${tier.tier.minQty}`,
      matched: true,
      amountPaise: tier.deltaPaise,
      runningUnitPaise: base,
    });
  }

  // `BASE` for percentage rules means the price after steps 1–3.
  const stepThreeBase = base;
  let running = base;

  // 4 — adjustments, in deterministic order
  const facts = buildFacts(line, qty, running, context, cartSubtotalEstimate, cartItemCount, now);
  const outcomes = matchAdjustments({
    line,
    qty,
    now,
    channel: context.channel,
    customerGroupId: context.customerGroup?.id ?? null,
    facts,
  });

  for (const outcome of outcomes) {
    const { adjustment } = outcome;

    if (!outcome.matched) {
      trace.push({
        step: 'adjustment',
        ruleId: adjustment.id,
        ruleName: adjustment.name,
        matched: false,
        reason: outcome.reason,
      });
      continue;
    }

    const basisAmount = adjustment.basis === 'BASE' ? stepThreeBase : running;
    let delta = 0;

    switch (adjustment.adjustmentType) {
      case 'FIXED_AMOUNT':
        delta = adjustment.valuePaise ?? 0;
        break;
      case 'PERCENT':
        delta = applyBasisPoints(basisAmount, adjustment.valueBp ?? 0);
        break;
      case 'PER_UNIT':
        // Charged per unit, so the per-unit figure is exactly the configured value.
        delta = adjustment.valuePaise ?? 0;
        break;
      case 'MULTIPLIER':
        delta = applyBasisPoints(running, adjustment.valueBp ?? 0) - running;
        break;
      default:
        trace.push({
          step: 'adjustment',
          ruleId: adjustment.id,
          ruleName: adjustment.name,
          matched: false,
          reason: `unknown adjustment type "${adjustment.adjustmentType}"`,
        });
        continue;
    }

    running = Math.max(0, running + delta);

    components.push({
      code: `ADJ_${adjustment.id}`,
      label: adjustment.name,
      kind: 'ADJUSTMENT',
      amountPaise: delta,
      sourceType: 'PRICE_ADJUSTMENT',
      sourceId: adjustment.id,
      meta: {
        scope: adjustment.scope,
        type: adjustment.adjustmentType,
        basis: adjustment.basis,
        priority: adjustment.priority,
      },
    });
    trace.push({
      step: 'adjustment',
      ruleId: adjustment.id,
      ruleName: adjustment.name,
      matched: true,
      amountPaise: delta,
      runningUnitPaise: running,
    });
  }

  // 5 — customisation hook (Prompt 11 fills this; empty by default)
  for (const component of requestLine.customizationAdjustments ?? []) {
    running = Math.max(0, running + component.amountPaise);
    components.push({ ...component, kind: 'ADJUSTMENT', sourceType: 'CUSTOMIZATION' });
    trace.push({
      step: 'customization',
      ruleId: component.sourceId ?? null,
      ruleName: component.label,
      matched: true,
      amountPaise: component.amountPaise,
      runningUnitPaise: running,
    });
  }

  // 6 — the customer group's blanket discount (CustomerGroup.discountBp), on the price after
  // every rule above, exactly once per unit.
  const group = context.customerGroup;
  if (group && group.discountBp !== null && group.discountBp > 0) {
    const delta = -applyBasisPoints(running, group.discountBp);
    running = Math.max(0, running + delta);
    components.push({
      code: `GROUP_${group.code}`,
      label: `${group.name} price`,
      kind: 'ADJUSTMENT',
      amountPaise: delta,
      sourceType: 'CUSTOMER_GROUP',
      sourceId: group.id,
      meta: { discountBp: group.discountBp },
    });
    trace.push({
      step: 'customerGroup',
      ruleId: group.id,
      ruleName: group.name,
      matched: true,
      amountPaise: delta,
      runningUnitPaise: running,
    });
  }

  // 7 — never negative
  const unitPricePaise = Math.max(0, running);

  // The BASE component plus every delta must equal the unit price; correct the BASE if a floor
  // clipped the stack, so the component list keeps summing exactly.
  const componentSum = sumComponents(components);
  if (componentSum !== unitPricePaise) {
    components.push({
      code: 'FLOOR',
      label: 'Minimum price floor',
      kind: 'ADJUSTMENT',
      amountPaise: unitPricePaise - componentSum,
      sourceType: 'PRICE_ADJUSTMENT',
      meta: { reason: 'discounts exceeded the price; floored at zero' },
    });
  }

  return { components, unitPricePaise, baseUnitPaise: line.baseUnitPaise, trace };
}

/* ------------------------------------------------------------ coupon maths */

function couponAppliesToLine(coupon: PricingCoupon, line: PricingLineContext): boolean {
  const rules = coupon.appliesTo;
  if (!rules) return true;

  if (rules.excludeProductIds?.includes(line.productId)) return false;
  if (rules.excludeCategoryIds?.some((id) => line.categoryIds.includes(id))) return false;

  const positives = [
    rules.productIds?.length ? rules.productIds.includes(line.productId) : null,
    rules.variantIds?.length
      ? Boolean(line.variantId && rules.variantIds.includes(line.variantId))
      : null,
    rules.categoryIds?.length
      ? rules.categoryIds.some((id) => line.categoryIds.includes(id))
      : null,
    rules.collectionIds?.length
      ? rules.collectionIds.some((id) => line.collectionIds.includes(id))
      : null,
  ].filter((value): value is boolean => value !== null);

  // With no positive filters the coupon covers everything; otherwise any one of them is enough.
  return positives.length === 0 || positives.some(Boolean);
}

export function couponDiscountFor(coupon: PricingCoupon, eligibleSubtotalPaise: number): number {
  if (eligibleSubtotalPaise <= 0) return 0;

  let discount = 0;
  if (coupon.type === 'PERCENT' || coupon.type === 'TIERED') {
    discount = applyBasisPoints(eligibleSubtotalPaise, coupon.valueBp ?? 0);
  } else if (coupon.type === 'FIXED') {
    discount = coupon.valuePaise ?? 0;
  }

  if (coupon.maxDiscountPaise !== null && coupon.maxDiscountPaise !== undefined) {
    discount = Math.min(discount, coupon.maxDiscountPaise);
  }

  return Math.min(discount, eligibleSubtotalPaise);
}

/* -------------------------------------------------------------- the engine */

export function calculate(
  context: PricingContext,
  request: PriceRequest,
  options: CalculateOptions = {},
): CalculateResult {
  const now = new Date(request.now);
  const engineVersion = options.engineVersion ?? ENGINE_VERSION_DEFAULT;
  const trace: PricingTraceStep[] = [];

  const byLineId = new Map(context.lines.map((line) => [line.lineId, line]));
  const cartItemCount = request.lines.reduce((total, line) => total + line.qty, 0);

  // Pass 1: unit prices and line subtotals.
  const drafts = request.lines.map((requestLine) => {
    const lineContext = byLineId.get(requestLine.lineId);
    if (!lineContext) {
      throw new PricingInvariantError('A requested line has no pricing context', {
        lineId: requestLine.lineId,
      });
    }

    const unit = resolveUnitPrice(lineContext, requestLine, context, now, 0, cartItemCount);
    if (options.collectTrace) {
      trace.push(
        ...unit.trace.map((step) => ({ ...step, step: `${requestLine.lineId}:${step.step}` })),
      );
    }

    // Steps 1–6 work per unit; a breakdown is read per line, so every component is scaled by qty.
    // That is what makes `sum(components) === totalPaise` true for any quantity.
    const components: PriceComponent[] = unit.components.map((component) => ({
      ...component,
      amountPaise: component.amountPaise * requestLine.qty,
      meta: { ...(component.meta ?? {}), unitPaise: component.amountPaise, qty: requestLine.qty },
    }));

    return {
      requestLine,
      lineContext,
      components,
      unitPricePaise: unit.unitPricePaise,
      baseUnitPaise: unit.baseUnitPaise,
      subtotalPaise: unit.unitPricePaise * requestLine.qty,
      discountPaise: 0,
    };
  });

  const grossSubtotal = drafts.reduce((total, draft) => total + draft.subtotalPaise, 0);

  /* 7 — automatic LINE-scope discount rules */
  for (const draft of drafts) {
    for (const rule of context.discountRules.filter((candidate) => candidate.scope === 'LINE')) {
      const facts = buildFacts(
        draft.lineContext,
        draft.requestLine.qty,
        draft.unitPricePaise,
        context,
        grossSubtotal,
        cartItemCount,
        now,
      );
      const outcome = evaluateConditionGroup(rule.conditions, facts);

      if (!outcome.matched) {
        if (options.collectTrace) {
          trace.push({
            step: `${draft.requestLine.lineId}:discountRule`,
            ruleId: rule.id,
            ruleName: rule.name,
            matched: false,
            reason: outcome.reason,
          });
        }
        continue;
      }

      for (const action of rule.actions) {
        if (action.type === 'FREE_SHIPPING') continue;

        let amount =
          action.type === 'PERCENT'
            ? applyBasisPoints(draft.subtotalPaise, action.valueBp ?? 0)
            : (action.valuePaise ?? 0);

        if (action.maxDiscountPaise !== undefined)
          amount = Math.min(amount, action.maxDiscountPaise);
        amount = Math.min(amount, draft.subtotalPaise - draft.discountPaise);
        if (amount <= 0) continue;

        draft.discountPaise += amount;
        draft.components.push({
          code: `RULE_${rule.code}`,
          label: rule.name,
          kind: 'DISCOUNT',
          amountPaise: -amount,
          sourceType: 'DISCOUNT_RULE',
          sourceId: rule.id,
        });

        if (options.collectTrace) {
          trace.push({
            step: `${draft.requestLine.lineId}:discountRule`,
            ruleId: rule.id,
            ruleName: rule.name,
            matched: true,
            amountPaise: -amount,
          });
        }
      }

      if (rule.stopFurtherRules) break;
    }
  }

  /* 8 — cart-level: the coupon, allocated back to lines proportionally */
  const cartComponents: PriceComponent[] = [];
  const appliedRuleIds: string[] = [];
  let appliedCouponCode: string | undefined;
  let couponGrantsFreeShipping = false;

  const coupon = context.coupon;
  if (coupon) {
    const eligible = drafts.filter((draft) => couponAppliesToLine(coupon, draft.lineContext));
    const eligibleSubtotal = eligible.reduce(
      (total, draft) => total + draft.subtotalPaise - draft.discountPaise,
      0,
    );

    if (coupon.type === 'FREE_SHIPPING') {
      couponGrantsFreeShipping = true;
      appliedCouponCode = coupon.code;
      appliedRuleIds.push(coupon.id);
    } else {
      const discount = couponDiscountFor(coupon, eligibleSubtotal);

      if (discount > 0) {
        appliedCouponCode = coupon.code;
        appliedRuleIds.push(coupon.id);

        // splitPaise's largest-remainder rule: allocations sum to the discount exactly.
        const weights = eligible.map((draft) => draft.subtotalPaise - draft.discountPaise);
        const allocations = allocateProportionally(discount, weights);

        eligible.forEach((draft, index) => {
          const amount = allocations[index] ?? 0;
          if (amount === 0) return;

          draft.discountPaise += amount;
          draft.components.push({
            code: `COUPON_${coupon.code}`,
            label: `Coupon ${coupon.code}`,
            kind: 'COUPON',
            amountPaise: -amount,
            sourceType: 'COUPON',
            sourceId: coupon.id,
            meta: { allocated: true },
          });
        });

        if (options.collectTrace) {
          trace.push({
            step: 'coupon',
            ruleId: coupon.id,
            ruleName: `Coupon ${coupon.code}`,
            matched: true,
            amountPaise: -discount,
          });
        }
      } else if (options.collectTrace) {
        trace.push({
          step: 'coupon',
          ruleId: coupon.id,
          ruleName: `Coupon ${coupon.code}`,
          matched: false,
          reason: 'no eligible items in the cart',
        });
      }
    }
  }

  const netSubtotal = drafts.reduce(
    (total, draft) => total + draft.subtotalPaise - draft.discountPaise,
    0,
  );

  /* 9 — shipping */
  let shippingPaise = 0;
  const totalWeightGrams = drafts.reduce(
    (total, draft) => total + (draft.lineContext.weightGrams ?? 0) * draft.requestLine.qty,
    0,
  );

  const rate = pickShippingRate(context, netSubtotal, totalWeightGrams, cartItemCount, request);

  if (rate) {
    const freeAbove = rate.freeAbovePaise ?? context.settings.freeShippingThresholdPaise;
    const qualifiesFree = freeAbove > 0 && netSubtotal >= freeAbove;

    shippingPaise = qualifiesFree
      ? 0
      : rate.basePaise + (rate.perUnitPaise ?? 0) * Math.max(0, cartItemCount - 1);

    if (couponGrantsFreeShipping) shippingPaise = 0;

    if (shippingPaise > 0) {
      cartComponents.push({
        code: `SHIP_${rate.method}`,
        label: rate.name,
        kind: 'SHIPPING',
        amountPaise: shippingPaise,
        sourceType: 'SHIPPING_RATE',
        sourceId: rate.id,
        meta: { zone: rate.zoneCode, method: rate.method, etaMinDays: rate.etaMinDays },
      });
    }

    if (options.collectTrace) {
      trace.push({
        step: 'shipping',
        ruleId: rate.id,
        ruleName: rate.name,
        matched: true,
        amountPaise: shippingPaise,
        reason: qualifiesFree
          ? 'free above threshold'
          : couponGrantsFreeShipping
            ? 'free shipping coupon'
            : undefined,
      });
    }
  }

  if (couponGrantsFreeShipping && coupon) {
    cartComponents.push({
      code: `COUPON_${coupon.code}`,
      label: `Coupon ${coupon.code} — free shipping`,
      kind: 'COUPON',
      amountPaise: 0,
      sourceType: 'COUPON',
      sourceId: coupon.id,
    });
  }

  /* 10 — tax per line */
  const shippingAllocations = allocateProportionally(
    context.settings.shippingTaxable ? shippingPaise : 0,
    drafts.map((draft) => Math.max(0, draft.subtotalPaise - draft.discountPaise)),
  );

  const lines: LineBreakdown[] = drafts.map((draft, index) => {
    const { settings } = context;
    const rateBp = draft.lineContext.taxClass.rateBp;
    const netLine = draft.subtotalPaise - draft.discountPaise;
    const allocatedShipping = shippingAllocations[index] ?? 0;
    const taxableBase = netLine + allocatedShipping;

    let taxPaise: number;
    let taxablePaise: number;

    if (settings.pricesIncludeTax) {
      // The price already contains the tax: extract it rather than adding on top.
      taxPaise = taxFromInclusive(taxableBase, rateBp);
      taxablePaise = taxableBase - taxPaise;
    } else {
      taxablePaise = taxableBase;
      taxPaise = applyBasisPoints(taxableBase, rateBp);
    }

    const taxSplit = splitGst(taxPaise, isIntraState(context));
    const components: PriceComponent[] = [...draft.components];

    if (taxPaise !== 0) {
      components.push({
        code: draft.lineContext.taxClass.code,
        label: `GST ${(rateBp / 100).toFixed(rateBp % 100 === 0 ? 0 : 2)}%`,
        kind: 'TAX',
        amountPaise: settings.pricesIncludeTax ? 0 : taxPaise,
        sourceType: 'TAX_CLASS',
        sourceId: draft.lineContext.taxClass.id,
        meta: { rateBp, inclusive: settings.pricesIncludeTax, ...taxSplit },
      });
    }

    const listPricePaise = draft.lineContext.listPricePaise ?? undefined;
    const savingsPaise = Math.max(
      0,
      (listPricePaise ?? draft.baseUnitPaise) * draft.requestLine.qty - netLine,
    );

    const totalPaise = settings.pricesIncludeTax ? netLine : netLine + taxPaise;

    const line: LineBreakdown = {
      lineId: draft.requestLine.lineId,
      productId: draft.lineContext.productId,
      variantId: draft.lineContext.variantId,
      qty: draft.requestLine.qty,
      baseUnitPaise: draft.baseUnitPaise,
      unitPricePaise: draft.unitPricePaise,
      ...(listPricePaise === undefined ? {} : { listPricePaise }),
      components,
      subtotalPaise: draft.subtotalPaise,
      discountPaise: draft.discountPaise,
      taxablePaise,
      taxPaise,
      taxRateBp: rateBp,
      taxSplit,
      ...(draft.lineContext.taxClass.hsnCode
        ? { hsnCode: draft.lineContext.taxClass.hsnCode }
        : {}),
      totalPaise,
      savingsPaise,
      savingsPercentBp: listPricePaise
        ? savingsPercentBp(listPricePaise * draft.requestLine.qty, netLine)
        : 0,
      isMadeToOrder: draft.lineContext.isMadeToOrder,
      ...(draft.lineContext.leadTimeDays === null
        ? {}
        : { leadTimeDays: draft.lineContext.leadTimeDays }),
    };

    return line;
  });

  const taxPaise = lines.reduce((total, line) => total + line.taxPaise, 0);
  const taxSplit = lines.reduce((total, line) => addSplit(total, line.taxSplit), ZERO_SPLIT);
  const discountPaise = drafts.reduce((total, draft) => total + draft.discountPaise, 0);

  /* 11 — rounding */
  const preRoundTotal =
    netSubtotal + shippingPaise + (context.settings.pricesIncludeTax ? 0 : taxPaise);

  const roundingPaise = context.settings.roundTotalToRupee
    ? rupeeRoundingAdjustment(preRoundTotal)
    : 0;

  if (roundingPaise !== 0) {
    cartComponents.push({
      code: 'ROUNDING',
      label: 'Rounded to the nearest rupee',
      kind: 'ROUNDING',
      amountPaise: roundingPaise,
      sourceType: 'ROUNDING',
    });
  }

  const grandTotalPaise = preRoundTotal + roundingPaise;

  for (const rule of context.discountRules) appliedRuleIds.push(rule.id);

  const breakdown: PriceBreakdown = {
    currency: 'INR',
    lines,
    components: cartComponents,
    subtotalPaise: grossSubtotal,
    discountPaise,
    shippingPaise,
    taxPaise,
    taxSplit,
    roundingPaise,
    grandTotalPaise,
    totalSavingsPaise: lines.reduce((total, line) => total + line.savingsPaise, 0),
    ...(appliedCouponCode ? { appliedCouponCode } : {}),
    appliedRuleIds: [...new Set(appliedRuleIds)],
    placeOfSupply: {
      sellerStateCode: context.settings.sellerStateCode,
      buyerStateCode: context.buyerStateCode ?? context.settings.defaultPlaceOfSupply,
      isIntraState: isIntraState(context),
      isFallback: context.buyerStateCode === null,
    },
    pricesIncludeTax: context.settings.pricesIncludeTax,
    calculatedAt: now.toISOString(),
    engineVersion,
    contextHash: hashContext(context, request),
  };

  assertInvariant(breakdown);
  return { breakdown, trace };
}

function isIntraState(context: PricingContext): boolean {
  const buyer = context.buyerStateCode ?? context.settings.defaultPlaceOfSupply;
  return buyer.toUpperCase() === context.settings.sellerStateCode.toUpperCase();
}

function pickShippingRate(
  context: PricingContext,
  netSubtotalPaise: number,
  totalWeightGrams: number,
  itemCount: number,
  request: PriceRequest,
) {
  const candidates = context.shippingRates
    .filter((rate) => !request.shippingMethod || rate.method === request.shippingMethod)
    .filter((rate) => {
      const value =
        rate.conditionType === 'WEIGHT'
          ? totalWeightGrams
          : rate.conditionType === 'ITEM_COUNT'
            ? itemCount
            : netSubtotalPaise;

      if (rate.minValue !== null && value < rate.minValue) return false;
      if (rate.maxValue !== null && value > rate.maxValue) return false;
      return true;
    })
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1));

  return candidates[0] ?? null;
}

/**
 * 12 — the safety net. If the parts ever stop summing to the whole we refuse to return a price
 * rather than quietly overcharging someone. This runs in production too.
 */
export function assertInvariant(breakdown: PriceBreakdown): void {
  const lineTotals = breakdown.lines.reduce((total, line) => total + line.totalPaise, 0);
  const cartTotal = sumComponents(breakdown.components);
  const expected = lineTotals + cartTotal;

  if (expected !== breakdown.grandTotalPaise) {
    throw new PricingInvariantError(
      'Line totals plus cart components do not equal the grand total',
      {
        lineTotals,
        cartTotal,
        grandTotalPaise: breakdown.grandTotalPaise,
        contextHash: breakdown.contextHash,
      },
    );
  }

  for (const line of breakdown.lines) {
    const componentSum = sumComponents(line.components);
    if (componentSum !== line.totalPaise) {
      throw new PricingInvariantError('Line components do not sum to the line total', {
        lineId: line.lineId,
        componentSum,
        totalPaise: line.totalPaise,
        contextHash: breakdown.contextHash,
      });
    }
  }
}

/** Cart-level entry point. `calculate` already handles multiple lines; this names the intent. */
export function calculateCart(
  context: PricingContext,
  request: PriceRequest,
  options: CalculateOptions = {},
): CalculateResult {
  return calculate(context, request, options);
}

export const pricingEngine = { calculate, calculateCart, assertInvariant, hashContext };
