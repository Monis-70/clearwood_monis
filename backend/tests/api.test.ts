import request from 'supertest';
import { describe, expect, it } from 'vitest';

import openapiDebt from '../../docs/openapi-debt.json';
import { createApp } from '../src/app';

import { mountedRoutes, normalise } from './helpers/routes';

const app = createApp();

/**
 * The debt ceiling. Lowering this is how the backlog is burned down; raising it is a review
 * failure. Prompt 15/16 owns taking it to zero.
 */
const DEBT_CEILING = 176;

describe('GET /api/v1/version', () => {
  it('reports the active driver for every external dependency', async () => {
    const response = await request(app).get('/api/v1/version');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe('ClearWood Furnitures');
    expect(response.body.data.env).toBe('test');
    expect(typeof response.body.data.version).toBe('string');
    expect(response.body.data.drivers).toStrictEqual({
      db: 'mysql',
      cache: 'memory',
      storage: 'local',
      mail: 'log',
      payment: 'mock',
      shipping: 'manual',
      otp: 'log',
      search: 'sql',
    });
  });
});

describe('GET /api/v1/settings/public', () => {
  it('returns the seeded public settings as a flat, typed key/value object', async () => {
    const response = await request(app).get('/api/v1/settings/public');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const settings = response.body.data;
    expect(settings['site.name']).toBe('ClearWood Furnitures');
    expect(settings['site.currency']).toBe('INR');
    expect(settings['site.usp_line']).toBe('100% in-house manufacturing. Zero outsourcing.');
    // valueType drives the decoding, so numbers and booleans are not strings (D3).
    expect(settings['site.gst_percent']).toBe(18);
    expect(settings['site.free_shipping_threshold']).toBe(999900);
    // Prompt 1 shipped this as a false placeholder; Prompt 9A turned the Route split on.
    expect(settings['payment.split.enabled']).toBe(true);
  });

  it('supports the optional group filter', async () => {
    const response = await request(app).get('/api/v1/settings/public').query({ group: 'payment' });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data).sort()).toStrictEqual([
      'payment.cod.enabled',
      'payment.cod.fee_paise',
      'payment.cod.max_order_paise',
      'payment.methods_enabled',
      'payment.split.enabled',
    ]);
  });
});

describe('OpenAPI (R7)', () => {
  it('documents every endpoint shipped so far', async () => {
    const response = await request(app).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(Object.keys(response.body.paths).sort()).toStrictEqual([
      '/api/v1/addresses/pincode/{pincode}',
      '/api/v1/admin/audit-logs',
      '/api/v1/admin/auth/login',
      '/api/v1/admin/auth/me',
      '/api/v1/admin/auth/refresh',
      '/api/v1/admin/auth/sessions',
      '/api/v1/admin/carts',
      '/api/v1/admin/carts/cleanup',
      '/api/v1/admin/carts/stats',
      '/api/v1/admin/carts/{id}',
      '/api/v1/admin/catalog/bulk',
      '/api/v1/admin/catalog/categories',
      '/api/v1/admin/catalog/categories/tree',
      '/api/v1/admin/catalog/categories/{id}',
      '/api/v1/admin/catalog/export/{entity}',
      '/api/v1/admin/catalog/import/{entity}',
      '/api/v1/admin/catalog/products',
      '/api/v1/admin/catalog/products/{id}/publish',
      '/api/v1/admin/catalog/products/{id}/search-document',
      '/api/v1/admin/catalog/products/{id}/variants/matrix/preview',
      '/api/v1/admin/catalog/variants/{id}/inventory/adjust',
      '/api/v1/admin/cms/announcements',
      '/api/v1/admin/cms/announcements/{id}',
      '/api/v1/admin/cms/banners',
      '/api/v1/admin/cms/banners/reorder',
      '/api/v1/admin/cms/banners/{id}',
      '/api/v1/admin/cms/banners/{id}/stats',
      '/api/v1/admin/cms/block-types',
      '/api/v1/admin/cms/faq-categories',
      '/api/v1/admin/cms/faq-categories/{id}',
      '/api/v1/admin/cms/faqs',
      '/api/v1/admin/cms/faqs/reorder',
      '/api/v1/admin/cms/faqs/{id}',
      '/api/v1/admin/cms/help/articles',
      '/api/v1/admin/cms/help/articles/reorder',
      '/api/v1/admin/cms/help/articles/{id}',
      '/api/v1/admin/cms/help/categories',
      '/api/v1/admin/cms/help/categories/{id}',
      '/api/v1/admin/cms/pages',
      '/api/v1/admin/cms/pages/{id}',
      '/api/v1/admin/cms/pages/{id}/blocks',
      '/api/v1/admin/cms/pages/{id}/blocks/reorder',
      '/api/v1/admin/cms/pages/{id}/blocks/{blockId}',
      '/api/v1/admin/cms/pages/{id}/duplicate',
      '/api/v1/admin/cms/pages/{id}/preview',
      '/api/v1/admin/cms/pages/{id}/publish',
      '/api/v1/admin/cms/pages/{id}/revisions',
      '/api/v1/admin/cms/pages/{id}/revisions/{version}/restore',
      '/api/v1/admin/cms/pages/{id}/schedule',
      '/api/v1/admin/cms/pages/{id}/unpublish',
      '/api/v1/admin/cms/stores',
      '/api/v1/admin/cms/stores/reorder',
      '/api/v1/admin/cms/stores/{id}',
      '/api/v1/admin/cms/testimonials',
      '/api/v1/admin/cms/testimonials/reorder',
      '/api/v1/admin/cms/testimonials/{id}',
      '/api/v1/admin/collections/rules/preview',
      '/api/v1/admin/collections/{id}/evaluate',
      '/api/v1/admin/content/settings',
      '/api/v1/admin/documents/{documentNumber}/download',
      '/api/v1/admin/media',
      '/api/v1/admin/media-folders',
      '/api/v1/admin/media/config',
      '/api/v1/admin/media/upload',
      '/api/v1/admin/media/{id}',
      '/api/v1/admin/media/{id}/permanent',
      '/api/v1/admin/navigation',
      '/api/v1/admin/navigation/items/{id}',
      '/api/v1/admin/navigation/{key}',
      '/api/v1/admin/navigation/{key}/items',
      '/api/v1/admin/navigation/{key}/reorder',
      '/api/v1/admin/ndr',
      '/api/v1/admin/ndr/{id}/action',
      '/api/v1/admin/notifications/logs',
      '/api/v1/admin/notifications/templates',
      '/api/v1/admin/orders',
      '/api/v1/admin/orders/reconcile',
      '/api/v1/admin/orders/{id}',
      '/api/v1/admin/orders/{id}/cancel',
      '/api/v1/admin/orders/{id}/ledger-check',
      '/api/v1/admin/orders/{id}/retry-transfers',
      '/api/v1/admin/orders/{id}/split-preview',
      '/api/v1/admin/orders/{id}/status',
      '/api/v1/admin/orders/{orderNumber}/documents',
      '/api/v1/admin/orders/{orderNumber}/documents/invoice',
      '/api/v1/admin/orders/{orderNumber}/refunds',
      '/api/v1/admin/orders/{orderNumber}/refunds/preview',
      '/api/v1/admin/orders/{orderNumber}/serviceability',
      '/api/v1/admin/orders/{orderNumber}/shipments',
      '/api/v1/admin/payments/attention',
      '/api/v1/admin/payments/settings',
      '/api/v1/admin/payments/split-accounts',
      '/api/v1/admin/payments/split-accounts/{id}',
      '/api/v1/admin/payments/split-rules',
      '/api/v1/admin/payments/split-rules/{id}',
      '/api/v1/admin/payments/split-simulate',
      '/api/v1/admin/permissions',
      '/api/v1/admin/pricing/coupons',
      '/api/v1/admin/pricing/explain/{id}',
      '/api/v1/admin/pricing/settings',
      '/api/v1/admin/pricing/simulate',
      '/api/v1/admin/products/{productId}/media',
      '/api/v1/admin/refunds/{id}/approve',
      '/api/v1/admin/refunds/{id}/credit-note',
      '/api/v1/admin/refunds/{id}/execute',
      '/api/v1/admin/reports',
      '/api/v1/admin/returns',
      '/api/v1/admin/returns/{returnNumber}',
      '/api/v1/admin/returns/{returnNumber}/approve',
      '/api/v1/admin/returns/{returnNumber}/complete',
      '/api/v1/admin/returns/{returnNumber}/inspect',
      '/api/v1/admin/returns/{returnNumber}/receive',
      '/api/v1/admin/returns/{returnNumber}/reject',
      '/api/v1/admin/roles',
      '/api/v1/admin/search/analytics',
      '/api/v1/admin/search/jobs/{id}',
      '/api/v1/admin/search/reindex',
      '/api/v1/admin/search/synonyms',
      '/api/v1/admin/seo/preview/{type}/{id}',
      '/api/v1/admin/seo/sitemap/rebuild',
      '/api/v1/admin/shipments',
      '/api/v1/admin/shipments/{shipmentNumber}',
      '/api/v1/admin/shipments/{shipmentNumber}/awb',
      '/api/v1/admin/shipments/{shipmentNumber}/cancel',
      '/api/v1/admin/shipments/{shipmentNumber}/pickup',
      '/api/v1/admin/shipments/{shipmentNumber}/status',
      '/api/v1/admin/shipments/{shipmentNumber}/sync',
      '/api/v1/admin/users',
      '/api/v1/admin/webhooks',
      '/api/v1/admin/webhooks/{id}/replay',
      '/api/v1/admin/wishlists/stats',
      '/api/v1/auth/login',
      '/api/v1/auth/me',
      '/api/v1/auth/otp/request',
      '/api/v1/auth/otp/verify',
      '/api/v1/auth/refresh',
      '/api/v1/auth/register',
      '/api/v1/cart',
      '/api/v1/cart/coupon',
      '/api/v1/cart/items',
      '/api/v1/cart/items/{lineId}',
      '/api/v1/cart/merge',
      '/api/v1/cart/pincode',
      '/api/v1/cart/summary',
      '/api/v1/cart/validate',
      '/api/v1/catalog/attributes',
      '/api/v1/catalog/best-sellers',
      '/api/v1/catalog/categories/tree',
      '/api/v1/catalog/categories/{slug}',
      '/api/v1/catalog/categories/{slug}/landing',
      '/api/v1/catalog/collections',
      '/api/v1/catalog/collections/{slug}',
      '/api/v1/catalog/deals',
      '/api/v1/catalog/featured',
      '/api/v1/catalog/filters',
      '/api/v1/catalog/new-arrivals',
      '/api/v1/catalog/products',
      '/api/v1/catalog/products/batch',
      '/api/v1/catalog/products/{slug}',
      '/api/v1/catalog/products/{slug}/gallery',
      '/api/v1/catalog/products/{slug}/options',
      '/api/v1/catalog/products/{slug}/price',
      '/api/v1/catalog/products/{slug}/related',
      '/api/v1/catalog/products/{slug}/view',
      '/api/v1/catalog/resolve',
      '/api/v1/checkout/init',
      '/api/v1/checkout/verify',
      '/api/v1/checkout/{sessionId}',
      '/api/v1/checkout/{sessionId}/abandon',
      '/api/v1/checkout/{sessionId}/place',
      '/api/v1/content/announcement',
      '/api/v1/content/banners',
      '/api/v1/content/banners/{id}/click',
      '/api/v1/content/banners/{id}/impression',
      '/api/v1/content/faq-categories',
      '/api/v1/content/faqs',
      '/api/v1/content/faqs/{id}/helpful',
      '/api/v1/content/help',
      '/api/v1/content/help/articles/{id}/helpful',
      '/api/v1/content/help/articles/{slug}',
      '/api/v1/content/help/{categorySlug}',
      '/api/v1/content/home',
      '/api/v1/content/pages/{slug}',
      '/api/v1/content/stores',
      '/api/v1/content/testimonials',
      '/api/v1/me/addresses',
      '/api/v1/me/orders',
      '/api/v1/me/orders/{orderNumber}',
      '/api/v1/me/orders/{orderNumber}/cancel',
      '/api/v1/me/orders/{orderNumber}/documents',
      '/api/v1/me/orders/{orderNumber}/invoice',
      '/api/v1/me/orders/{orderNumber}/returnable',
      '/api/v1/me/orders/{orderNumber}/returns',
      '/api/v1/me/orders/{orderNumber}/shipments',
      '/api/v1/me/orders/{orderNumber}/timeline',
      '/api/v1/me/recently-viewed',
      '/api/v1/navigation/{key}',
      '/api/v1/orders/track',
      '/api/v1/pricing/quote',
      '/api/v1/pricing/validate-coupon',
      '/api/v1/search',
      '/api/v1/search/click',
      '/api/v1/search/suggest',
      '/api/v1/settings/public',
      '/api/v1/shipping/serviceability/{pincode}',
      '/api/v1/track/shipments/{awb}',
      '/api/v1/version',
      '/api/v1/webhooks/razorpay',
      '/api/v1/wishlists',
      '/api/v1/wishlists/shared/{token}',
      '/health',
      '/ready',
      '/robots.txt',
      '/sitemap-{section}.xml',
      '/sitemap.xml',
    ]);
  });

  /**
   * R7's completeness ratchet.
   *
   * The list above asserts the documented paths EXIST. It says nothing about the routes that are
   * mounted and undocumented, which is how 176 of them accumulated unnoticed across Prompts 1-8.
   *
   * So: every mounted route must be documented, or explicitly recorded as legacy debt. The debt
   * file may only shrink. Adding an entry fails this test, which is the whole point — new work
   * documents itself and the backlog cannot grow.
   */
  it('documents every mounted route, or records it as legacy debt', async () => {
    const response = await request(app).get('/openapi.json');

    const documented = new Set<string>();
    for (const [routePath, operations] of Object.entries(response.body.paths)) {
      for (const method of Object.keys(operations as object)) {
        documented.add(normalise(`${method.toUpperCase()} ${routePath}`));
      }
    }

    const debt = new Set(openapiDebt.routes);
    const mounted = mountedRoutes(app);

    /**
     * G1: `undocumented` is also empty when nothing was enumerated. The predecessor of this test
     * asserted 119 documented paths exist while 176 mounted routes were undocumented, and passed
     * for exactly that reason. So prove both sides are real first.
     */
    expect(mounted.length, 'no routes were enumerated from the Express stack').toBeGreaterThan(200);
    expect(documented.size, 'the OpenAPI document is empty').toBeGreaterThan(100);

    const undocumented = mounted.filter((route) => !documented.has(route) && !debt.has(route));

    expect(
      undocumented,
      `These routes are mounted but neither documented nor recorded as debt:\n${undocumented.join('\n')}\n\nDocument them with registry.registerPath(). Do NOT add them to docs/openapi-debt.json.`,
    ).toEqual([]);
  });

  it('never lets the documentation debt grow', () => {
    // The recorded count is the ratchet. It may fall, never rise.
    expect(openapiDebt.routes.length).toBe(openapiDebt.count);
    expect(openapiDebt.count).toBeLessThanOrEqual(DEBT_CEILING);
  });

  it('records no debt for a route that is already documented', async () => {
    const response = await request(app).get('/openapi.json');

    const documented = new Set<string>();
    for (const [routePath, operations] of Object.entries(response.body.paths)) {
      for (const method of Object.keys(operations as object)) {
        documented.add(normalise(`${method.toUpperCase()} ${routePath}`));
      }
    }

    // A documented route sitting in the debt list is debt that was paid but never struck off.
    const stale = openapiDebt.routes.filter((route) => documented.has(route));

    // G1: an empty debt list would make the assertion below vacuously true.
    expect(openapiDebt.routes.length, 'the debt list is empty').toBeGreaterThan(0);
    expect(documented.size, 'the OpenAPI document is empty').toBeGreaterThan(100);

    expect(stale, `Documented, but still listed as debt:\n${stale.join('\n')}`).toEqual([]);
  });

  it('serves Swagger UI at /docs', async () => {
    const response = await request(app).get('/docs/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('ClearWood Furnitures API docs');
  });
});