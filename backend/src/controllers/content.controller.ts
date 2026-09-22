import type { Request, Response } from 'express';

import type {
  CmsReorderInput,
  ContentSettingsInput,
  NavigationItemCreateInput,
  NavigationItemUpdateInput,
  StoreCreateInput,
  StoreUpdateInput,
  TestimonialCreateInput,
  TestimonialUpdateInput,
} from '@shared/schemas/cms';

import { auditService } from '../modules/auth/audit.service';
import {
  navigationAdminService,
  siteSettingsService,
  storeService,
  testimonialService,
} from '../modules/cms/content.service';
import { seoService, SITEMAP_SECTIONS, type SitemapSection } from '../modules/cms/seo.service';
import { AppError } from '../utils/AppError';
import { created, noContent, ok } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

export const publicContentController = {
  async testimonials(req: Request, res: Response): Promise<void> {
    const featured = req.query.featured === 'true' ? true : undefined;
    ok(res, await testimonialService.list({ featured }));
  },

  async stores(_req: Request, res: Response): Promise<void> {
    ok(res, await storeService.list());
  },
};

export const adminTestimonialController = {
  async list(_req: Request, res: Response): Promise<void> {
    ok(res, await testimonialService.list({ includeInactive: true }));
  },

  async create(req: Request, res: Response): Promise<void> {
    const row = await testimonialService.create(req.body as TestimonialCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Testimonial',
      entityId: row.id,
      severity: 'NOTICE',
    });

    created(res, row);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const row = await testimonialService.update(id, req.body as TestimonialUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Testimonial',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, row);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await testimonialService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Testimonial',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    await testimonialService.reorder(req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Testimonial',
      entityId: 'reorder',
      severity: 'INFO',
    });

    noContent(res);
  },
};

export const adminStoreController = {
  async list(_req: Request, res: Response): Promise<void> {
    ok(res, await storeService.list(true));
  },

  async create(req: Request, res: Response): Promise<void> {
    const row = await storeService.create(req.body as StoreCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'StoreLocation',
      entityId: row.id,
      severity: 'NOTICE',
    });

    created(res, row);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const row = await storeService.update(id, req.body as StoreUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'StoreLocation',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, row);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await storeService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'StoreLocation',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    await storeService.reorder(req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'StoreLocation',
      entityId: 'reorder',
      severity: 'INFO',
    });

    noContent(res);
  },
};

export const adminNavigationController = {
  async listMenus(_req: Request, res: Response): Promise<void> {
    ok(res, await navigationAdminService.listMenus());
  },

  async menu(req: Request, res: Response): Promise<void> {
    const { key } = req.params as { key: string };
    ok(res, await navigationAdminService.menu(key));
  },

  async createItem(req: Request, res: Response): Promise<void> {
    const { key } = req.params as { key: string };
    const item = await navigationAdminService.createItem(key, req.body as NavigationItemCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'NavigationItem',
      entityId: item.id,
      severity: 'NOTICE',
      meta: { menu: key, label: item.label },
    });

    created(res, item);
  },

  async updateItem(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const item = await navigationAdminService.updateItem(id, req.body as NavigationItemUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'NavigationItem',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, item);
  },

  async removeItem(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await navigationAdminService.removeItem(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'NavigationItem',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const { key } = req.params as { key: string };
    await navigationAdminService.reorder(key, req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'NavigationItem',
      entityId: key,
      severity: 'INFO',
      meta: { action: 'reorder' },
    });

    noContent(res);
  },
};

export const adminContentSettingsController = {
  async get(_req: Request, res: Response): Promise<void> {
    ok(res, await siteSettingsService.get());
  },

  async put(req: Request, res: Response): Promise<void> {
    const settings = await siteSettingsService.set(req.body as ContentSettingsInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AppSetting',
      entityId: 'content',
      severity: 'CRITICAL',
      meta: { keys: Object.keys(req.body as object) },
    });

    ok(res, settings);
  },
};

export const adminSeoController = {
  async rebuild(req: Request, res: Response): Promise<void> {
    const result = await seoService.rebuild();

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Sitemap',
      entityId: 'rebuild',
      severity: 'INFO',
      meta: result.sections,
    });

    ok(res, result);
  },

  async preview(req: Request, res: Response): Promise<void> {
    const { type, id } = req.params as { type: string; id: string };
    const known = ['PAGE', 'PRODUCT', 'CATEGORY', 'COLLECTION', 'HELP_ARTICLE'];

    if (!known.includes(type.toUpperCase())) {
      throw AppError.validation(`Unknown entity type "${type}"`, { known });
    }

    ok(res, await seoService.metaFor(type.toUpperCase() as never, id));
  },
};

/* ------------------------------------------- root-mounted, outside /api/v1 */

export const seoRootController = {
  async sitemapIndex(_req: Request, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(await seoService.index());
  },

  async sitemapSection(req: Request, res: Response): Promise<void> {
    const { section } = req.params as { section: string };

    // 'products' or 'products-2': the suffix is the page number.
    const match = /^([a-z]+)(?:-(\d+))?$/.exec(section);
    const name = match?.[1] as SitemapSection | undefined;
    const page = match?.[2] ? Number(match[2]) : 1;

    if (!name || !SITEMAP_SECTIONS.includes(name)) {
      res.status(404).setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset/>\n');
      return;
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(await seoService.section(name, page));
  },

  async robots(_req: Request, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(await seoService.robots());
  },
};
