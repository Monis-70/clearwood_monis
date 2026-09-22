import { allocateProportionally } from '@shared/money';

/**
 * Who gives the money back, and how much each.
 *
 * PURE: no Prisma, no clock, no I/O.
 *
 * THE PROBLEM THIS SOLVES: when a ₹6,000 order was split ₹5,000 to PRIMARY and ₹1,000 to PARTNER_A,
 * a refund cannot simply come out of the platform's pocket. The partner was paid, so the partner's
 * share has to be reversed too — and the reversals must sum to exactly the refund, or the ledger
 * stops balancing and nobody can tell whose money is missing.
 *
 * THE INVARIANT: `sum(reversals) === refundPaise`, exactly, always. Like the split engine, this is
 * not approached by careful rounding; the amounts come from `allocateProportionally`, which is
 * lossless, and the result is asserted afterwards. A violation throws rather than quietly
 * under-reversing.
 *
 * TWO POLICIES:
 *  - PROPORTIONAL — every account gives back its share of the refund, in proportion to what it
 *    received. The default, and the fair one.
 *  - PRIMARY_FIRST — the platform absorbs as much as it can before touching a partner. Used when
 *    the refund is our fault (a pricing error, a lost parcel) and the partner should not suffer.
 */

export class ReversalPlanError extends Error {
  readonly code = 'REVERSAL_PLAN_INVALID';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ReversalPlanError';
  }
}

export type ReversalPolicy = 'PROPORTIONAL' | 'PRIMARY_FIRST';

/** A transfer that actually completed, as `PaymentTransfer` records it. */
export interface ReversibleTransfer {
  transferId: string;
  providerTransferId: string | null;
  accountId: string;
  accountKey: string;
  accountName: string;
  providerAccountId: string;
  isPrimary: boolean;
  amountPaise: number;
  /** Already reversed by an earlier refund. */
  reversedPaise: number;
}

export interface PlannedReversal {
  transferId: string;
  providerTransferId: string | null;
  accountId: string;
  accountKey: string;
  accountName: string;
  providerAccountId: string;
  isPrimary: boolean;
  amountPaise: number;
  /** What was available to reverse on this transfer before this plan. */
  availablePaise: number;
  note: string | null;
}

export interface ReversalPlan {
  refundPaise: number;
  /** What the platform pays out of its own settlement, once every partner has given back its share. */
  primaryAbsorbedPaise: number;
  reversals: PlannedReversal[];
  totalReversedPaise: number;
  policy: ReversalPolicy;
  /** True when the transfers could not cover the refund and the shortfall falls on the platform. */
  hasShortfall: boolean;
  shortfallPaise: number;
}

export function availableToReverse(transfer: ReversibleTransfer): number {
  return Math.max(transfer.amountPaise - transfer.reversedPaise, 0);
}

/**
 * Plans the reversals for a refund.
 *
 * Reversals are planned against SPECIFIC transfers rather than against accounts, because that is
 * what the provider needs: you reverse a transfer, not a relationship. It is also what keeps the
 * plan auditable — every rupee traces back to the transfer it is undoing.
 */
export function planReversals(
  refundPaise: number,
  transfers: ReversibleTransfer[],
  policy: ReversalPolicy = 'PROPORTIONAL',
): ReversalPlan {
  if (!Number.isInteger(refundPaise) || refundPaise <= 0) {
    throw new ReversalPlanError('A reversal plan needs a positive whole-paise refund', {
      refundPaise,
    });
  }

  const reversible = transfers
    .map((transfer) => ({ transfer, available: availableToReverse(transfer) }))
    .filter((entry) => entry.available > 0);

  // No split, or everything already reversed: the platform simply refunds from its own balance.
  if (reversible.length === 0) {
    return {
      refundPaise,
      primaryAbsorbedPaise: refundPaise,
      reversals: [],
      totalReversedPaise: 0,
      policy,
      hasShortfall: false,
      shortfallPaise: 0,
    };
  }

  const totalAvailable = reversible.reduce((total, entry) => total + entry.available, 0);

  // More refund than was ever transferred out. The remainder is the platform's to bear; it is not
  // an error, and it must not silently vanish.
  const target = Math.min(refundPaise, totalAvailable);
  const shortfallPaise = refundPaise - target;

  const planned: PlannedReversal[] =
    policy === 'PRIMARY_FIRST'
      ? planPrimaryFirst(target, reversible)
      : planProportional(target, reversible);

  const withAmounts = planned.filter((entry) => entry.amountPaise > 0);
  const totalReversedPaise = withAmounts.reduce((total, entry) => total + entry.amountPaise, 0);

  // The assertion that makes this safe to wire to real money.
  if (totalReversedPaise !== target) {
    throw new ReversalPlanError('The planned reversals do not add up to the refund', {
      refundPaise,
      target,
      totalReversedPaise,
      policy,
    });
  }

  for (const entry of withAmounts) {
    if (entry.amountPaise > entry.availablePaise) {
      throw new ReversalPlanError('A reversal exceeds what that transfer still holds', {
        transferId: entry.transferId,
        amountPaise: entry.amountPaise,
        availablePaise: entry.availablePaise,
      });
    }
  }

  return {
    refundPaise,
    // What the platform is left carrying: the shortfall, plus whatever the primary reverses is NOT
    // absorbed — a primary reversal is money coming back from our own linked account.
    primaryAbsorbedPaise: shortfallPaise,
    reversals: withAmounts,
    totalReversedPaise,
    policy,
    hasShortfall: shortfallPaise > 0,
    shortfallPaise,
  };
}

/** Every account gives back its share, weighted by what it still holds. Lossless. */
function planProportional(
  target: number,
  reversible: { transfer: ReversibleTransfer; available: number }[],
): PlannedReversal[] {
  const amounts = allocateProportionally(
    target,
    reversible.map((entry) => entry.available),
  );

  // Proportional allocation can hand a bucket more than it holds only if weights and caps
  // disagree; they cannot here, because the weight IS the cap. Clamping is belt and braces.
  return reversible.map((entry, index) =>
    toPlanned(entry, Math.min(amounts[index] ?? 0, entry.available), 'Proportional share'),
  );
}

/** The platform absorbs first; partners are only touched once our own share is exhausted. */
function planPrimaryFirst(
  target: number,
  reversible: { transfer: ReversibleTransfer; available: number }[],
): PlannedReversal[] {
  const ordered = [...reversible].sort(
    (a, b) => Number(b.transfer.isPrimary) - Number(a.transfer.isPrimary),
  );

  let left = target;

  const planned = ordered.map((entry) => {
    const amount = Math.min(entry.available, left);
    left -= amount;

    return toPlanned(
      entry,
      amount,
      entry.transfer.isPrimary ? 'Platform absorbs first' : 'Partner share after platform',
    );
  });

  // Restore the caller's ordering so the plan reads the same way the transfers do.
  return reversible.map(
    (entry) => planned.find((candidate) => candidate.transferId === entry.transfer.transferId)!,
  );
}

function toPlanned(
  entry: { transfer: ReversibleTransfer; available: number },
  amountPaise: number,
  note: string,
): PlannedReversal {
  return {
    transferId: entry.transfer.transferId,
    providerTransferId: entry.transfer.providerTransferId,
    accountId: entry.transfer.accountId,
    accountKey: entry.transfer.accountKey,
    accountName: entry.transfer.accountName,
    providerAccountId: entry.transfer.providerAccountId,
    isPrimary: entry.transfer.isPrimary,
    amountPaise,
    availablePaise: entry.available,
    note: amountPaise > 0 ? note : 'Nothing left to reverse',
  };
}
