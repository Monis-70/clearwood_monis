import type { CollectionType } from '@shared/enums';
import type { CollectionRules } from '@shared/schemas/catalogAdmin';

/**
 * Pure data. AUTOMATIC collections carry their rules as a JSON string (D3), in the one DSL that
 * Prompt 5 validates and Prompt 7 compiles to a Prisma `where`.
 */

export interface SeedCollection {
  slug: string;
  name: string;
  type: CollectionType;
  description: string;
  rules: CollectionRules;
  position: number;
}

type SeedRule = CollectionRules['groups'][number]['rules'][number];

/** Every seeded collection is a single ALL group; the DSL supports far more. */
const single = (
  field: SeedRule['field'],
  operator: SeedRule['operator'],
  value: SeedRule['value'],
  limit?: number,
): CollectionRules => ({
  match: 'ALL',
  groups: [{ match: 'ALL', rules: [{ field, operator, value }] }],
  ...(limit ? { limit } : {}),
});

export const COLLECTIONS: SeedCollection[] = [
  {
    slug: 'new-arrivals',
    name: 'New Arrivals',
    type: 'AUTOMATIC',
    description: 'Everything that left the workshop in the last 60 days.',
    rules: single('isNewArrival', 'EQUALS', true),
    position: 1,
  },
  {
    slug: 'special-collection',
    name: 'Special Collection',
    type: 'AUTOMATIC',
    description: 'Limited runs and designer pieces.',
    rules: single('isSpecialCollection', 'EQUALS', true),
    position: 2,
  },
  {
    slug: 'best-sellers',
    name: 'Best Sellers',
    type: 'AUTOMATIC',
    description: 'The pieces our workshop builds most often.',
    rules: single('isBestSeller', 'EQUALS', true),
    position: 3,
  },
  {
    slug: 'deals-of-the-week',
    name: 'Deals of the Week',
    type: 'AUTOMATIC',
    description: 'Anything currently priced below its compare-at price.',
    rules: single('compareAtPricePaise', 'GREATER_THAN', 0, 12),
    position: 4,
  },
  {
    slug: 'made-to-order',
    name: 'Made to Order',
    type: 'AUTOMATIC',
    description: 'Built to your size, fabric and finish — zero outsourcing.',
    rules: single('isMadeToOrder', 'EQUALS', true),
    position: 5,
  },
];
