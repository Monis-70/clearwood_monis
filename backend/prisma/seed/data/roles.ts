import { PERMISSION_CODES, type AdminRoleCode, type Permission } from '@shared/enums';

/** Pure data. Patterns are matched with a single trailing `*` wildcard. */

export interface SeedRole {
  code: AdminRoleCode;
  name: string;
  description: string;
  position: number;
  /** `*` alone means every permission in the registry. */
  grants: string[];
  /** Explicitly withheld even if a grant pattern would match. */
  denies?: string[];
}

export const ROLES: SeedRole[] = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Unrestricted access, including roles, payments and the audit trail.',
    position: 1,
    grants: ['*'],
  },
  {
    code: 'ADMIN',
    name: 'Admin',
    description: 'Runs the business day to day; cannot change roles or payment settings.',
    position: 2,
    grants: ['*'],
    denies: [
      'system.role.*',
      'system.user.delete',
      'payment.settings.update',
      'payment.split.update',
    ],
  },
  {
    code: 'CATALOG_MANAGER',
    name: 'Catalog Manager',
    description: 'Owns products, categories, attributes, media and price adjustments.',
    position: 3,
    grants: [
      'catalog.*',
      'pricing.adjustment.*',
      'pricing.tax.read',
      'media.*',
      'cms.navigation.read',
    ],
  },
  {
    code: 'ORDER_MANAGER',
    name: 'Order Manager',
    description: 'Processes orders, inventory and customer records; cannot approve refunds.',
    position: 4,
    grants: [
      'order.order.*',
      'order.customer.*',
      'order.refund.read',
      'order.refund.create',
      'catalog.product.read',
      'catalog.inventory.*',
      'lead.enquiry.read',
    ],
  },
  {
    code: 'CONTENT_MANAGER',
    name: 'Content Manager',
    description: 'Owns pages, banners, FAQs, navigation, media and enquiries.',
    position: 5,
    grants: ['cms.*', 'media.*', 'lead.enquiry.*', 'catalog.category.read', 'catalog.product.read'],
  },
];

function matches(code: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('*') ? code.startsWith(pattern.slice(0, -1)) : code === pattern;
}

export function resolveRolePermissions(role: SeedRole): Permission[] {
  return PERMISSION_CODES.filter(
    (code) =>
      role.grants.some((pattern) => matches(code, pattern)) &&
      !(role.denies ?? []).some((pattern) => matches(code, pattern)),
  );
}
