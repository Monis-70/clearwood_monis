import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { categoryDetailSchema, navigationMenuDtoSchema } from '@shared/schemas/catalog';

import { createApp } from '../src/app';
import { categoryAttributeService } from '../src/services/categoryAttribute.service';
import { productService } from '../src/services/product.service';

const app = createApp();

interface TreeNode {
  slug: string;
  kind: string;
  depth: number;
  children: TreeNode[];
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe('GET /api/v1/catalog/categories/tree', () => {
  it('returns the whole site map, correctly nested', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/tree');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const roots = response.body.data as TreeNode[];
    const all = flatten(roots);

    expect(roots).toHaveLength(16);
    expect(all).toHaveLength(160);

    const sofas = roots.find((node) => node.slug === 'sofas');
    expect(sofas?.children).toHaveLength(21);
    expect(roots.find((node) => node.slug === 'chairs')?.children).toHaveLength(13);
    expect(roots.find((node) => node.slug === 'dining')?.children).toHaveLength(12);
    expect(roots.find((node) => node.slug === 'bedroom-headboard')?.children).toHaveLength(6);
    expect(roots.find((node) => node.slug === 'furniture-pillows')?.children).toHaveLength(18);
    expect(roots.find((node) => node.slug === 'furniture-accessories')?.children).toHaveLength(12);
    expect(roots.find((node) => node.slug === 'contract-based-work')?.children).toHaveLength(9);
    expect(roots.find((node) => node.slug === 'new-arrivals')?.children).toHaveLength(0);
  });

  it('applies the derived category kinds', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/tree');
    const byslug = new Map(flatten(response.body.data as TreeNode[]).map((n) => [n.slug, n]));

    expect(byslug.get('all-sofas')?.kind).toBe('ALL');
    expect(byslug.get('special-collection-sofas')?.kind).toBe('SPECIAL_COLLECTION');
    expect(byslug.get('make-your-own-sofas')?.kind).toBe('MAKE_YOUR_OWN');
    expect(byslug.get('new-arrivals')?.kind).toBe('NEW_ARRIVALS');
    expect(byslug.get('interior-living-room')?.kind).toBe('INTERIOR_SOLUTION');
    expect(byslug.get('fabric-sofas')?.kind).toBe('STANDARD');
    expect(byslug.get('exclusive-accessories')?.kind).toBe('SPECIAL_COLLECTION');
    expect(byslug.get('contract-based-work')?.kind).toBe('SERVICE');
    expect(byslug.get('custom-bank-furniture')?.kind).toBe('SERVICE');
  });

  it('honours the depth limit', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/tree').query({ depth: 1 });

    const all = flatten(response.body.data as TreeNode[]);
    expect(all).toHaveLength(16);
    expect(all.every((node) => node.depth === 0)).toBe(true);
  });

  it('rejects an out-of-range depth with 422', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/tree').query({ depth: 99 });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.traceId).toBeTruthy();
  });
});

describe('GET /api/v1/catalog/categories/:slug', () => {
  it('returns breadcrumbs, children and inherited attributes', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/fabric-sofas');

    expect(response.status).toBe(200);
    const detail = categoryDetailSchema.parse(response.body.data);

    expect(detail.slug).toBe('fabric-sofas');
    expect(detail.path).toBe('sofas/fabric-sofas');
    expect(detail.breadcrumbs.map((crumb) => crumb.slug)).toStrictEqual(['sofas', 'fabric-sofas']);
    expect(detail.seoTitle).toContain('ClearWood Furnitures');
    expect(detail.children).toHaveLength(0);
  });

  it('404s for an unknown slug, with the error envelope', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/not-a-category');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.traceId).toBeTruthy();
  });

  it('422s for a malformed slug', async () => {
    const response = await request(app).get('/api/v1/catalog/categories/NOT_A_SLUG');

    expect(response.status).toBe(422);
    expect(response.body.error.details[0]).toMatchObject({ location: 'params', path: 'slug' });
  });
});

describe('attribute inheritance', () => {
  it('gives a child category every attribute defined on its ancestor', async () => {
    const resolved = await categoryAttributeService.resolveForCategorySlug('fabric-sofas');
    const codes = resolved.map((attribute) => attribute.code);

    expect(codes).toEqual(
      expect.arrayContaining(['COLOUR', 'FABRIC', 'SEATER', 'LEG_TYPE', 'FILLING', 'ARM_STYLE']),
    );
    expect(resolved.every((attribute) => attribute.inheritedFrom === 'sofas')).toBe(true);
  });

  it('lets a child override an inherited flag', async () => {
    const resolved = await categoryAttributeService.resolveForCategorySlug('leather-sofas');
    const fabric = resolved.find((attribute) => attribute.code === 'FABRIC');

    expect(fabric?.inheritedFrom).toBe('leather-sofas');
    expect(fabric?.isRequiredForCategory).toBe(true);

    const colour = resolved.find((attribute) => attribute.code === 'COLOUR');
    expect(colour?.inheritedFrom).toBe('sofas');
  });
});

describe('GET /api/v1/catalog/attributes', () => {
  it('lists the global dictionary with pagination meta (R5)', async () => {
    const response = await request(app).get('/api/v1/catalog/attributes').query({ limit: 5 });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(5);
    expect(response.body.meta).toMatchObject({ page: 1, limit: 5, total: 18, hasNext: true });
  });

  it('resolves the inherited set when a categorySlug is supplied', async () => {
    const response = await request(app)
      .get('/api/v1/catalog/attributes')
      .query({ categorySlug: 'fabric-sofas' });

    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(6);
    expect(response.body.data.map((attribute: { code: string }) => attribute.code)).toContain(
      'FABRIC',
    );
  });

  it('422s on an unsortable field', async () => {
    const response = await request(app)
      .get('/api/v1/catalog/attributes')
      .query({ sort: 'dropTable' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/navigation/:key', () => {
  it('returns the MAIN mega-menu entirely from the database', async () => {
    const response = await request(app).get('/api/v1/navigation/MAIN');

    expect(response.status).toBe(200);
    const menu = navigationMenuDtoSchema.parse(response.body.data);

    const furnitures = menu.items.find((item) => item.label === 'Furnitures');
    expect(furnitures?.url).toBe('/');
    expect(furnitures?.children[0]?.label).toBe('All Products');

    const sofas = furnitures?.children.find((item) => item.categorySlug === 'sofas');
    expect(sofas?.url).toBe('/c/sofas');
    expect(sofas?.children).toHaveLength(21);

    // A service line sits beside "Furnitures", not inside it.
    const contract = menu.items.find((item) => item.categorySlug === 'contract-based-work');
    expect(contract?.children).toHaveLength(9);
    expect(furnitures?.children.some((item) => item.categorySlug === 'contract-based-work')).toBe(
      false,
    );
  });

  it('carries the three lead-capture items with their form keys', async () => {
    const response = await request(app).get('/api/v1/navigation/MAIN');
    const menu = navigationMenuDtoSchema.parse(response.body.data);

    const leadForms = menu.items.filter((item) => item.type === 'LEAD_FORM');
    expect(leadForms.map((item) => item.leadFormKey)).toStrictEqual([
      'home-interiors',
      'bulk-order',
      'become-a-partner',
    ]);
    expect(menu.items.find((item) => item.label === 'New Arrivals')?.isHighlighted).toBe(true);
  });

  it('serves the footer and top bar too', async () => {
    const footer = await request(app).get('/api/v1/navigation/FOOTER_PRIMARY');
    expect(footer.status).toBe(200);
    expect(footer.body.data.items.map((item: { label: string }) => item.label)).toStrictEqual([
      'Help Center',
      'FAQ',
      'Track Order',
      'Contact Us',
      'About Us',
    ]);

    const topBar = await request(app).get('/api/v1/navigation/TOP_BAR');
    expect(topBar.status).toBe(200);
  });

  it('422s on an unknown menu key', async () => {
    const response = await request(app).get('/api/v1/navigation/NOPE');

    expect(response.status).toBe(422);
    expect(response.body.error.traceId).toBeTruthy();
  });
});

describe('product mapping (proves the schema end to end)', () => {
  it('maps a seeded demo product onto the shared ProductDetail shape', async () => {
    const product = await productService.getBySlug('kabir-3-seater-fabric-sofa');

    expect(product.sku).toBe('CW-SOF-KABIR');
    expect(product.basePricePaise).toBe(4599900);
    expect(product.categories.length).toBeGreaterThanOrEqual(4);
    expect(product.variants).toHaveLength(6);
    expect(product.media.length).toBeGreaterThanOrEqual(6);

    // A variant with no price of its own inherits the product base price (no maths until Prompt 6).
    const inherited = product.variants.find((variant) => variant.pricePaise === null);
    expect(inherited?.effectiveBasePricePaise).toBe(4599900);

    // Colour-specific and variant-specific imagery, plus a mobile-only asset.
    expect(product.media.some((row) => row.attributeValueId !== null)).toBe(true);
    expect(product.media.some((row) => row.variantId !== null)).toBe(true);
    expect(product.media.some((row) => row.deviceTarget === 'MOBILE')).toBe(true);

    // Media URLs come from the StorageDriver, never hardcoded. Prompt 4 moved the seeded rasters
    // into the `products` system folder, and keys are now date-partitioned.
    expect(product.media[0]?.url.startsWith('http://localhost:7180/media/products/')).toBe(true);

    expect(product.specs.map((spec) => spec.attributeCode)).toContain('WOOD_TYPE');
  });

  it('exposes the made-to-order product with customization enabled', async () => {
    const product = await productService.getBySlug('make-your-own-modular-sofa');

    expect(product.isMadeToOrder).toBe(true);
    expect(product.allowCustomization).toBe(true);
    expect(product.leadTimeDays).toBe(28);
    expect(product.productType).toBe('MADE_TO_ORDER');
  });
});

describe('OpenAPI', () => {
  it('documents the four catalog endpoints', async () => {
    const response = await request(app).get('/openapi.json');
    const paths = Object.keys(response.body.paths);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/catalog/categories/tree',
        '/api/v1/catalog/categories/{slug}',
        '/api/v1/catalog/attributes',
        '/api/v1/navigation/{key}',
      ]),
    );
  });
});
