import type { SplitBasis, SplitMode, SplitScope } from '@shared/enums';
import { splitPaise, type SplitRule as MoneySplitRule } from '@shared/money';

/**
 * The split calculator.
 *
 * PURE: no Prisma, no clock, no I/O. Everything it needs arrives as fixtures, which is what makes
 * the canonical ₹6,000 → PRIMARY ₹5,000 + PARTNER_A ₹1,000 case a unit test rather than an
 * integration test.
 *
 * THE INVARIANT: `sum(allocations) === transferablePaise`, exactly, always. It is not approached by
 * rounding carefully — the final amounts are produced by `shared/money.splitPaise`, which does
 * largest-remainder integer splitting with zero paise loss, and the result is asserted afterwards.
 * A violation throws `SPLIT_INVARIANT_VIOLATION` rather than quietly shipping money to nowhere.
 *
 * FEES: provider fees are deducted from the primary account's settlement, not from the transferable
 * amount, because Razorpay charges the platform rather than the linked accounts. A rule can cap its
 * own exposure with `maxTransferPaise`.
 */

export class SplitInvariantError extends Error {
  readonly code = 'SPLIT_INVARIANT_VIOLATION';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SplitInvariantError';
  }
}

export interface SplitRuleInput {
  id: string | null;
  code: string;
  scope: SplitScope;
  scopeEntityId: string | null;
  basis: SplitBasis;
  mode: SplitMode;
  valuePaise: number | null;
  valueBp: number | null;
  recipientKey: string;
  priority: number;
  minOrderPaise: number | null;
  maxTransferPaise: number | null;
  onHold: boolean;
  onHoldUntil: Date | null;
}

export interface SplitAccountInput {
  id: string;
  key: string;
  name: string;
  providerAccountId: string;
  isPrimary: boolean;
  isActive: boolean;
}

export interface SplitOrderLine {
  orderItemId: string;
  productId: string;
  /** Every category the line belongs to, ANCESTORS INCLUDED (materialised path, Prompt 2). */
  categoryIds: string[];
  collectionIds: string[];
  brandId: string | null;
  lineSubtotalPaise: number;
  lineTotalPaise: number;
}

export interface SplitOrderContext {
  orderId: string;
  subtotalPaise: number;
  grandTotalPaise: number;
  lines: SplitOrderLine[];
}

export interface ComputedAllocation {
  accountId: string;
  accountKey: string;
  accountName: string;
  providerAccountId: string;
  ruleId: string | null;
  ruleCode: string | null;
  orderItemId: string | null;
  amountPaise: number;
  basisAmountPaise: number;
  mode: SplitMode;
  sequence: number;
  isRemainder: boolean;
  onHold: boolean;
  onHoldUntil: Date | null;
  /** Why this ended at zero, or why it was clamped. Kept for audit even when unremarkable. */
  note: string | null;
}

export interface SplitComputation {
  transferablePaise: number;
  allocatedPaise: number;
  allocations: ComputedAllocation[];
  rulesApplied: { code: string; scope: SplitScope; mode: SplitMode; priority: number }[];
}

/** More specific rules win ties: a PRODUCT rule should beat a GLOBAL one at the same priority. */
const SPECIFICITY: Record<SplitScope, number> = {
  GLOBAL: 0,
  BRAND: 1,
  COLLECTION: 2,
  CATEGORY: 3,
  PRODUCT: 4,
};

export function ruleMatchesLine(rule: SplitRuleInput, line: SplitOrderLine): boolean {
  switch (rule.scope) {
    case 'GLOBAL':
      return true;
    case 'PRODUCT':
      return line.productId === rule.scopeEntityId;
    case 'BRAND':
      return line.brandId !== null && line.brandId === rule.scopeEntityId;
    case 'COLLECTION':
      return line.collectionIds.includes(rule.scopeEntityId ?? '');
    case 'CATEGORY':
      // Ancestors are already in categoryIds, so a rule on "Sofas" matches a "Fabric Sofas" line.
      return line.categoryIds.includes(rule.scopeEntityId ?? '');
    default:
      return false;
  }
}

/** Sorted the way they must be evaluated: priority, then specificity, then a stable id tiebreak. */
export function orderRules(rules: SplitRuleInput[]): SplitRuleInput[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      SPECIFICITY[a.scope] - SPECIFICITY[b.scope] ||
      (a.id ?? a.code).localeCompare(b.id ?? b.code),
  );
}

function basisAmount(
  rule: SplitRuleInput,
  order: SplitOrderContext,
  matched: SplitOrderLine[],
): number {
  switch (rule.basis) {
    case 'ORDER_TOTAL':
      return order.grandTotalPaise;
    case 'ORDER_SUBTOTAL':
      return order.subtotalPaise;
    case 'LINE_TOTAL':
      return matched.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    case 'LINE_SUBTOTAL':
      return matched.reduce((sum, line) => sum + line.lineSubtotalPaise, 0);
    default:
      return order.grandTotalPaise;
  }
}

/** floor(basis * bp / 10_000) in BigInt, so a large order cannot drift through float maths. */
function percentOf(basisPaise: number, valueBp: number): number {
  return Number((BigInt(basisPaise) * BigInt(valueBp)) / 10_000n);
}

export function computeSplit(
  order: SplitOrderContext,
  transferablePaise: number,
  rules: SplitRuleInput[],
  accounts: SplitAccountInput[],
): SplitComputation {
  if (!Number.isInteger(transferablePaise) || transferablePaise < 0) {
    throw new SplitInvariantError('transferablePaise must be a non-negative integer', {
      transferablePaise,
    });
  }

  const accountByKey = new Map(accounts.filter((a) => a.isActive).map((a) => [a.key, a]));
  const primary = accounts.find((account) => account.isPrimary && account.isActive);

  const ordered = orderRules(
    rules.filter((rule) => {
      if ((rule.minOrderPaise ?? 0) > order.grandTotalPaise) return false;
      return accountByKey.has(rule.recipientKey);
    }),
  );

  const remainderRules = ordered.filter((rule) => rule.mode === 'REMAINDER');
  if (remainderRules.length > 1) {
    throw new SplitInvariantError('at most one REMAINDER rule may apply to an order', {
      codes: remainderRules.map((rule) => rule.code),
    });
  }

  const remainderRule = remainderRules[0] ?? null;
  const fixedAndPercent = ordered.filter((rule) => rule.mode !== 'REMAINDER');

  const allocations: ComputedAllocation[] = [];
  const rulesApplied: SplitComputation['rulesApplied'] = [];

  let remaining = transferablePaise;
  let sequence = 0;

  for (const rule of fixedAndPercent) {
    const account = accountByKey.get(rule.recipientKey)!;
    const matched = order.lines.filter((line) => ruleMatchesLine(rule, line));

    // A scoped rule with nothing to apply to is skipped entirely, not allocated zero by accident.
    if (rule.scope !== 'GLOBAL' && matched.length === 0) continue;

    const basis = basisAmount(rule, order, matched);
    const desired =
      rule.mode === 'FIXED'
        ? (rule.valuePaise ?? 0) * (rule.basis.startsWith('LINE_') ? matched.length : 1)
        : percentOf(basis, rule.valueBp ?? 0);

    const notes: string[] = [];
    let amount = desired;

    if (rule.maxTransferPaise !== null && amount > rule.maxTransferPaise) {
      notes.push(`capped at maxTransferPaise ${rule.maxTransferPaise} (wanted ${desired})`);
      amount = rule.maxTransferPaise;
    }
    if (amount > remaining) {
      notes.push(`clamped to the ${remaining} paise left (wanted ${amount})`);
      amount = remaining;
    }
    if (amount < 0) amount = 0;
    if (amount === 0 && notes.length === 0) notes.push('rule produced no amount');

    remaining -= amount;
    rulesApplied.push({
      code: rule.code,
      scope: rule.scope,
      mode: rule.mode,
      priority: rule.priority,
    });

    allocations.push({
      accountId: account.id,
      accountKey: account.key,
      accountName: account.name,
      providerAccountId: account.providerAccountId,
      ruleId: rule.id,
      ruleCode: rule.code,
      orderItemId: null,
      amountPaise: amount,
      basisAmountPaise: basis,
      mode: rule.mode,
      sequence: sequence++,
      isRemainder: false,
      onHold: rule.onHold,
      onHoldUntil: rule.onHoldUntil,
      note: notes.length > 0 ? notes.join('; ') : null,
    });
  }

  // The residue always has an owner: an explicit REMAINDER rule, or the primary account.
  const remainderAccount = remainderRule ? accountByKey.get(remainderRule.recipientKey) : primary;

  if (!remainderAccount) {
    throw new SplitInvariantError(
      'no REMAINDER rule and no active primary account to receive the residue',
      { remaining },
    );
  }

  if (remainderRule) {
    rulesApplied.push({
      code: remainderRule.code,
      scope: remainderRule.scope,
      mode: 'REMAINDER',
      priority: remainderRule.priority,
    });
  }

  allocations.push({
    accountId: remainderAccount.id,
    accountKey: remainderAccount.key,
    accountName: remainderAccount.name,
    providerAccountId: remainderAccount.providerAccountId,
    ruleId: remainderRule?.id ?? null,
    ruleCode: remainderRule?.code ?? null,
    orderItemId: null,
    amountPaise: remaining,
    basisAmountPaise: transferablePaise,
    mode: 'REMAINDER',
    sequence: sequence++,
    isRemainder: true,
    onHold: remainderRule?.onHold ?? false,
    onHoldUntil: remainderRule?.onHoldUntil ?? null,
    note: remainderRule ? null : 'residue to the primary account (no REMAINDER rule configured)',
  });

  /*
   * The exactness step. Everything above decided INTENT; `splitPaise` decides the final paise, and
   * it is the same helper the money tests already pin (600000 over [500000, REMAINDER] -> 500000 +
   * 100000). Handing it our clamped amounts as FIXED plus one REMAINDER means the sum cannot drift.
   */
  const moneyRules: MoneySplitRule[] = allocations.map((allocation) =>
    allocation.isRemainder
      ? { mode: 'REMAINDER', account: allocation.providerAccountId }
      : { mode: 'FIXED', value: allocation.amountPaise, account: allocation.providerAccountId },
  );

  const exact = splitPaise(transferablePaise, moneyRules);
  exact.forEach((entry, index) => {
    allocations[index]!.amountPaise = entry.amountPaise;
  });

  const allocatedPaise = allocations.reduce((sum, entry) => sum + entry.amountPaise, 0);
  if (allocatedPaise !== transferablePaise) {
    throw new SplitInvariantError('allocations do not sum to the transferable amount', {
      transferablePaise,
      allocatedPaise,
      allocations: allocations.map((entry) => ({
        account: entry.accountKey,
        amountPaise: entry.amountPaise,
      })),
    });
  }

  return { transferablePaise, allocatedPaise, allocations, rulesApplied };
}
