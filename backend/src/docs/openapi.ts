import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { API_PREFIX } from '@shared/constants';

import { env } from '../config/env';
import { readPackageVersion } from '../utils/packageInfo';

import { registry } from './registry';

type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

let cached: OpenApiDocument | null = null;

/**
 * Generated lazily so that every route module has had a chance to call `registry.registerPath()`
 * before the document is produced.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  if (cached) return cached;

  cached = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: `${env.APP_NAME} API`,
      version: readPackageVersion(),
      description: [
        '**ClearWood Furnitures** — premium Indian furniture, 100% in-house manufacturing,',
        'zero outsourcing, every product manufactured individually.',
        '',
        'Every response uses one envelope:',
        '',
        '```json',
        '{ "success": true, "data": {}, "meta": null }',
        '{ "success": false, "error": { "code": "SNAKE_CASE", "message": "", "details": null, "traceId": "uuid" } }',
        '```',
        '',
        'Money is always an **integer number of paise**. List endpoints accept',
        '`page`, `limit` (max 100), `sort`, `order`.',
      ].join('\n'),
      contact: { name: 'ClearWood support', email: env.SUPPORT_EMAIL },
    },
    servers: [{ url: `http://localhost:${env.API_PORT}`, description: 'Local development' }],
    tags: [
      { name: 'System', description: 'Liveness, readiness and build information' },
      { name: 'Settings', description: 'Admin-managed configuration exposed to the storefront' },
      { name: 'Catalog', description: 'Categories, attributes and the products they describe' },
      { name: 'Navigation', description: 'Database-driven menus — nothing is hardcoded in React' },
      { name: 'Admin auth', description: 'Admin realm sessions (cw_adm_* cookies)' },
      {
        name: 'Admin management',
        description: 'Admin users, roles, permissions and the audit trail',
      },
      { name: 'Customer auth', description: 'Storefront realm sessions (cw_cus_* cookies)' },
      {
        name: 'Media',
        description: 'Uploads, renditions, the media library and product galleries',
      },
      {
        name: 'Admin catalog',
        description: 'Catalog CRUD, the variant matrix, inventory and CSV import/export',
      },
      {
        name: 'Pricing',
        description: 'The single price engine: adjustments, tiers, coupons, GST and shipping',
      },
      {
        name: 'Storefront',
        description: 'Listing, facets, the product page, collections and slug resolution',
      },
      {
        name: 'Search',
        description: 'Full-text search, autocomplete, synonyms, reindexing and analytics',
      },
      {
        name: 'Cart',
        description: 'Guest and customer carts, validation, coupons and the merge on login',
      },
      {
        name: 'Wishlist',
        description: 'Wishlists, sharing and price-drop detection',
      },
      {
        name: 'Address',
        description: 'The customer address book and pincode autofill',
      },
      {
        name: 'Checkout',
        description: 'Checkout sessions, order placement and payment verification',
      },
      {
        name: 'Orders',
        description: 'Customer order history, guest tracking and admin order management',
      },
      {
        name: 'Payments',
        description: 'The payment ledger, Razorpay Route split rules, webhooks and reconciliation',
      },
    ],
    externalDocs: {
      description: 'Project constitution',
      url: `http://localhost:${env.API_PORT}${API_PREFIX}/version`,
    },
  });

  return cached;
}
