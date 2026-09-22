import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';

import { blockRegistryManifest } from '@shared/cms/blockRegistry';
import type {
  AnnouncementCreateInput,
  AnnouncementUpdateInput,
  BannerCreateInput,
  BannerListQuery,
  BannerPublicQuery,
  BannerUpdateInput,
  BlockCreateInput,
  BlockReorderInput,
  BlockUpdateInput,
  CmsReorderInput,
  ContentPageQuery,
  PageCreateInput,
  PageDuplicateInput,
  PageListQuery,
  PageScheduleInput,
  PageUpdateInput,
} from '@shared/schemas/cms';
import type { DeviceKind } from '@shared/enums';

import { env } from '../config/env';
import { auditService } from '../modules/auth/audit.service';
import { announcementService, bannerService } from '../modules/cms/banner.service';
import { pageRendererService } from '../modules/cms/pageRenderer.service';
import { pageService, type Actor } from '../modules/cms/page.service';
import { logger } from '../config/logger';
import { AppError } from '../utils/AppError';
import { created, noContent, ok, paginated } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

function actorOf(req: Request): Actor {
  return { actorId: req.auth?.principalId ?? null, actorName: req.auth?.displayName ?? null };
}

/** Only a signed-in CUSTOMER changes prices; an admin previewing sees default-group pricing. */
function customerIdOf(req: Request): string | null {
  return req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
}

function deviceOf(req: Request, explicit?: DeviceKind): DeviceKind {
  if (explicit) return explicit;

  const agent = String(req.headers['user-agent'] ?? '');
  return /mobile|android|iphone|ipad/i.test(agent) ? 'MOBILE' : 'DESKTOP';
}

/** Weak ETag over the payload, matching the Prompt 7 storefront helper. */
function withETag(req: Request, res: Response, body: unknown): boolean {
  const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`;

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `public, max-age=${env.CMS_CACHE_TTL_SECONDS}`);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

function pageDto(page: Awaited<ReturnType<typeof pageService.get>>) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    type: page.type,
    status: page.status,
    template: page.template,
    excerpt: page.excerpt,
    heroMediaId: page.heroMediaId,
    ogMediaId: page.ogMediaId,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
    seoKeywords: page.seoKeywords,
    canonicalUrl: page.canonicalUrl,
    noIndex: page.noIndex,
    isSystem: page.isSystem,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    scheduledAt: page.scheduledAt?.toISOString() ?? null,
    expiresAt: page.expiresAt?.toISOString() ?? null,
    viewCount: page.viewCount,
    version: page.version,
    updatedAt: page.updatedAt.toISOString(),
    blocks: page.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      position: block.position,
      isActive: block.isActive,
      deviceVisibility: block.deviceVisibility,
      config: JSON.parse(block.configJson) as unknown,
      rawConfig: block.rawConfigJson ? (JSON.parse(block.rawConfigJson) as unknown) : null,
      startsAt: block.startsAt?.toISOString() ?? null,
      endsAt: block.endsAt?.toISOString() ?? null,
      anchorId: block.anchorId,
      cssClass: block.cssClass,
    })),
  };
}

/* ----------------------------------------------------------------- public */

export const contentController = {
  async home(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ContentPageQuery;

    const page = await pageRendererService.renderHome({
      device: deviceOf(req, query.device),
      customerId: customerIdOf(req),
      customerGroupId: null,
    });

    if (withETag(req, res, page)) return;
    ok(res, page);
  },

  async page(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as { slug: string };
    const query = req.query as unknown as ContentPageQuery;

    const page = await pageRendererService.renderBySlug(slug, {
      device: deviceOf(req, query.device),
      customerId: customerIdOf(req),
      customerGroupId: null,
    });

    if (withETag(req, res, page)) return;
    ok(res, page);
  },

  async banners(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as BannerPublicQuery;

    const banners = await bannerService.forPlacement(
      query.placement,
      deviceOf(req, query.device),
      new Date(),
      { categoryId: query.categoryId, collectionId: query.collectionId },
    );

    if (withETag(req, res, banners)) return;
    ok(res, banners);
  },

  /**
   * 202 and fire-and-forget. A counter must never make the page that reported it slower, and a
   * failed counter must never surface to a shopper.
   */
  async impression(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };

    void bannerService
      .recordImpression(id)
      .catch((error: unknown) => logger.debug({ err: error, id }, 'banner impression skipped'));

    res.status(202).json({ success: true, data: { accepted: true }, meta: null });
  },

  async click(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };

    void bannerService
      .recordClick(id)
      .catch((error: unknown) => logger.debug({ err: error, id }, 'banner click skipped'));

    res.status(202).json({ success: true, data: { accepted: true }, meta: null });
  },

  async announcement(req: Request, res: Response): Promise<void> {
    const announcement = await announcementService.current(deviceOf(req));

    if (withETag(req, res, announcement)) return;
    ok(res, announcement);
  },
};

/* ------------------------------------------------------------------ admin */

export const adminPageController = {
  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as PageListQuery;
    const page = await pageService.list(query);

    paginated(res, page.items.map(pageDto), page);
  },

  async get(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    ok(res, pageDto(await pageService.get(id)));
  },

  async create(req: Request, res: Response): Promise<void> {
    const page = await pageService.create(req.body as PageCreateInput, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Page',
      entityId: page.id,
      severity: 'NOTICE',
      meta: { slug: page.slug },
    });

    created(res, pageDto(page));
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.update(id, req.body as PageUpdateInput, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Page',
      entityId: id,
      severity: 'NOTICE',
      meta: { slug: page.slug },
    });

    ok(res, pageDto(page));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await pageService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Page',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async duplicate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const copy = await pageService.duplicate(id, req.body as PageDuplicateInput, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Page',
      entityId: copy.id,
      severity: 'NOTICE',
      meta: { duplicatedFrom: id },
    });

    created(res, pageDto(copy));
  },

  async publish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.publish(id, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Page',
      entityId: id,
      severity: 'CRITICAL',
      meta: { slug: page.slug, status: 'PUBLISHED' },
    });

    ok(res, pageDto(page));
  },

  async unpublish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.unpublish(id, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Page',
      entityId: id,
      severity: 'CRITICAL',
      meta: { slug: page.slug, status: 'DRAFT' },
    });

    ok(res, pageDto(page));
  },

  async schedule(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.schedule(id, req.body as PageScheduleInput, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Page',
      entityId: id,
      severity: 'CRITICAL',
      meta: { slug: page.slug, status: 'SCHEDULED' },
    });

    ok(res, pageDto(page));
  },

  async preview(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.get(id);

    ok(
      res,
      await pageRendererService.hydrate(page, {
        preview: true,
        device: deviceOf(req),
        customerId: null,
      }),
    );
  },

  /* ------------------------------------------------------------ blocks */

  async addBlock(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.addBlock(id, req.body as BlockCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PageBlock',
      entityId: id,
      severity: 'NOTICE',
      meta: { action: 'add', type: (req.body as BlockCreateInput).type },
    });

    created(res, pageDto(page));
  },

  async updateBlock(req: Request, res: Response): Promise<void> {
    const { id, blockId } = req.params as { id: string; blockId: string };
    const page = await pageService.updateBlock(id, blockId, req.body as BlockUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PageBlock',
      entityId: blockId,
      severity: 'NOTICE',
    });

    ok(res, pageDto(page));
  },

  async removeBlock(req: Request, res: Response): Promise<void> {
    const { id, blockId } = req.params as { id: string; blockId: string };
    const page = await pageService.removeBlock(id, blockId);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'PageBlock',
      entityId: blockId,
      severity: 'NOTICE',
    });

    ok(res, pageDto(page));
  },

  async reorderBlocks(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const page = await pageService.reorderBlocks(id, req.body as BlockReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PageBlock',
      entityId: id,
      severity: 'NOTICE',
      meta: { action: 'reorder' },
    });

    ok(res, pageDto(page));
  },

  /* --------------------------------------------------------- revisions */

  async listRevisions(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await pageService.get(id);

    ok(
      res,
      (await pageService.listRevisions(id)).map((revision) => ({
        ...revision,
        createdAt: revision.createdAt.toISOString(),
      })),
    );
  },

  async restoreRevision(req: Request, res: Response): Promise<void> {
    const { id, version } = req.params as { id: string; version: string };
    const parsed = Number(version);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw AppError.validation('Revision version must be a positive integer', { version });
    }

    const page = await pageService.restoreRevision(id, parsed, actorOf(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Page',
      entityId: id,
      severity: 'CRITICAL',
      meta: { restoredVersion: parsed },
    });

    ok(res, pageDto(page));
  },

  /** The registry as JSON, so Prompt 15's builder is generated rather than hardcoded. */
  blockTypes(_req: Request, res: Response): void {
    ok(res, blockRegistryManifest());
  },
};

export const adminBannerController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await bannerService.list(req.query as unknown as BannerListQuery);
    paginated(res, page.items, page);
  },

  async create(req: Request, res: Response): Promise<void> {
    const banner = await bannerService.create(req.body as BannerCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Banner',
      entityId: banner.id,
      severity: 'NOTICE',
      meta: { placement: banner.placement },
    });

    created(res, banner);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const banner = await bannerService.update(id, req.body as BannerUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Banner',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, banner);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await bannerService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Banner',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    await bannerService.reorder(req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Banner',
      entityId: 'reorder',
      severity: 'INFO',
    });

    noContent(res);
  },

  async stats(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    ok(res, await bannerService.stats(id));
  },
};

export const adminAnnouncementController = {
  async list(_req: Request, res: Response): Promise<void> {
    ok(res, await announcementService.list());
  },

  async create(req: Request, res: Response): Promise<void> {
    const row = await announcementService.create(req.body as AnnouncementCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'AnnouncementBar',
      entityId: row.id,
      severity: 'NOTICE',
    });

    created(res, row);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const row = await announcementService.update(id, req.body as AnnouncementUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AnnouncementBar',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, row);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await announcementService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'AnnouncementBar',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },
};
