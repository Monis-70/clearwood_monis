import { log, prisma } from './context';

/**
 * The split policy, expressed as data.
 *
 * ₹1,000 of every order goes to the manufacturing partner and ClearWood keeps the rest. That is a
 * business decision, so it lives in two rows an admin can edit — not in a constant somebody has to
 * redeploy to change.
 *
 * The evaluation order is priority ascending, so the FIXED rule (10) is taken first and the
 * REMAINDER rule (100) sweeps up whatever is left. A ₹6,000 order therefore splits
 * PARTNER_A ₹1,000 + PRIMARY ₹5,000, exactly.
 */

const RULES = [
  {
    code: 'partner-fixed-1000',
    name: 'Manufacturing partner — ₹1,000 per order',
    scope: 'GLOBAL',
    basis: 'ORDER_TOTAL',
    mode: 'FIXED',
    valuePaise: 100_000,
    valueBp: null,
    recipientKey: 'PARTNER_A',
    priority: 10,
    isActive: true,
    notes: 'Taken before the remainder. Clamped if the order is smaller than the fixed amount.',
  },
  {
    code: 'primary-remainder',
    name: 'ClearWood — everything else',
    scope: 'GLOBAL',
    basis: 'ORDER_TOTAL',
    mode: 'REMAINDER',
    valuePaise: null,
    valueBp: null,
    recipientKey: 'PRIMARY',
    priority: 100,
    isActive: true,
    notes: 'Exactly one active REMAINDER rule is allowed — the residue has one owner.',
  },
  {
    // Inactive: a worked example of a scoped percentage, so the shape is obvious in the admin UI.
    code: 'sofas-partner-percent',
    name: 'Sofas — 15% to the partner (example, off by default)',
    scope: 'CATEGORY',
    basis: 'LINE_TOTAL',
    mode: 'PERCENT',
    valuePaise: null,
    valueBp: 1_500,
    recipientKey: 'PARTNER_A',
    priority: 20,
    isActive: false,
    notes: 'Applies only to lines in Sofas or any of its descendants.',
  },
];

export async function seedSplitRules(): Promise<void> {
  const sofas = await prisma.category.findUnique({ where: { slug: 'sofas' } });
  let created = 0;

  for (const rule of RULES) {
    const scopeEntityId = rule.scope === 'CATEGORY' ? (sofas?.id ?? null) : null;

    // A CATEGORY rule with nothing to point at would never match; skip it rather than store junk.
    if (rule.scope === 'CATEGORY' && !scopeEntityId) continue;

    const existing = await prisma.splitRule.findUnique({ where: { code: rule.code } });

    if (existing) {
      // Structure is resynced; `isActive` is the admin's switch and is left alone.
      await prisma.splitRule.update({
        where: { code: rule.code },
        data: {
          name: rule.name,
          scope: rule.scope,
          scopeEntityId,
          basis: rule.basis,
          mode: rule.mode,
          valuePaise: rule.valuePaise,
          valueBp: rule.valueBp,
          recipientKey: rule.recipientKey,
          priority: rule.priority,
          notes: rule.notes,
        },
      });
      continue;
    }

    await prisma.splitRule.create({ data: { ...rule, scopeEntityId } });
    created += 1;
  }

  log('split-rules', `${RULES.length} split rules ensured (${created} created)`);
}
