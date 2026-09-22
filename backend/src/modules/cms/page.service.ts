import type {
  BlockCreateInput,
  BlockReorderInput,
  BlockUpdateInput,
  PageCreateInput,
  PageDuplicateInput,
  PageListQuery,
  PageScheduleInput,
  PageUpdateInput,
} from '@shared/schemas/cms';
import type { BlockType, PageStatus } from '@shared/enums';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  pageBlockRepository,
  pageRepository,
  pageRevisionRepository,
  type PageWithBlocks,
} from '../../repositories/page.repository';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { slugRedirectService } from '../catalog-admin/slugRedirect.service';
import { mediaUsageService } from '../media/media-usage.service';

import { blockValidator, type ValidatedBlock } from './blockValidator';
import { cmsCacheService } from './cmsCache.service';

const blockConfig = jsonColumn<Record<string, unknown>>(undefined, 'PageBlock.configJson');
const snapshot = jsonColumn<PageSnapshot>(undefined, 'PageRevision.snapshotJson');

export interface PageSnapshot {
  slug: string;
  title: string;
  type: string;
  template: string | null;
  excerpt: string | null;
  heroMediaId: string | null;
  ogMediaId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  canonicalUrl: string | null;
  noIndex: boolean;
  blocks: {
    type: string;
    position: number;
    isActive: boolean;
    deviceVisibility: string;
    configJson: string;
    rawConfigJson: string | null;
    startsAt: string | null;
    endsAt: string | null;
    anchorId: string | null;
    cssClass: string | null;
  }[];
}

export interface Actor {
  actorId: string | null;
  actorName: string | null;
}

/**
 * Pages, blocks and the publish gate.
 *
 * The gate is modelled on Prompt 5's product publish gate deliberately: it returns EVERY blocker
 * at once rather than the first, because an editor fixing a homepage one 422 at a time is how a
 * launch slips an afternoon.
 */
export const pageService = {
  list(query: PageListQuery) {
    return pageRepository.list(query);
  },

  async get(id: string): Promise<PageWithBlocks> {
    const page = await pageRepository.findById(id);
    if (!page) throw AppError.notFound('Page not found', { id });
    return page;
  },

  async create(input: PageCreateInput, actor: Actor): Promise<PageWithBlocks> {
    await this.assertSlugFree(input.slug, null);

    const page = await pageRepository.create({
      ...input,
      template: input.template ?? null,
      excerpt: input.excerpt ?? null,
      heroMediaId: input.heroMediaId ?? null,
      ogMediaId: input.ogMediaId ?? null,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
      seoKeywords: input.seoKeywords ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      status: 'DRAFT',
      authorId: actor.actorId,
      lastEditedById: actor.actorId,
    });

    await this.syncPageMedia(page);
    await cmsCacheService.invalidatePages();

    return page;
  },

  async update(id: string, input: PageUpdateInput, actor: Actor): Promise<PageWithBlocks> {
    const existing = await this.get(id);
    const { version, ...data } = input;

    if (data.slug && data.slug !== existing.slug) {
      await this.assertSlugFree(data.slug, id);
    }

    await updateVersioned(
      (await import('../../config/prisma')).prisma.page,
      'Page',
      id,
      version,
      { ...data, lastEditedById: actor.actorId },
    );

    // The redirect is written AFTER the rename lands, so a failed update leaves no orphan.
    if (data.slug && data.slug !== existing.slug) {
      await slugRedirectService.recordSlugChange('PAGE', id, existing.slug, data.slug);
    }

    const page = await this.get(id);
    await this.syncPageMedia(page);
    await cmsCacheService.invalidatePages();

    return page;
  },

  async remove(id: string): Promise<void> {
    const page = await this.get(id);

    if (page.isSystem) {
      throw new AppError(
        409,
        'PAGE_IS_SYSTEM',
        'This page is part of the storefront\u2019s fixed routes and cannot be deleted. Unpublish it instead.',
        { slug: page.slug },
      );
    }

    await pageRepository.softDelete(id);
    await mediaUsageService.detachEntity('CMS_PAGE', id);
    await cmsCacheService.invalidatePages();
  },

  async assertSlugFree(slug: string, exceptId: string | null): Promise<void> {
    const clash = await pageRepository.slugExists(slug, exceptId);
    if (clash) {
      throw new AppError(409, 'SLUG_TAKEN', `Another page already uses "${slug}"`, { slug });
    }

    // Pages share the storefront's root namespace with products, categories and collections.
    await slugRedirectService.assertSlugFree('PAGE', slug, exceptId);
  },

  /* ------------------------------------------------------------- blocks */

  async addBlock(pageId: string, input: BlockCreateInput): Promise<PageWithBlocks> {
    const page = await this.get(pageId);
    const count = await pageBlockRepository.countForPage(pageId);

    if (count >= env.CMS_MAX_BLOCKS_PER_PAGE) {
      throw AppError.validation(`A page may hold at most ${env.CMS_MAX_BLOCKS_PER_PAGE} blocks`, {
        max: env.CMS_MAX_BLOCKS_PER_PAGE,
      });
    }

    const existing = page.blocks.map((block) => ({ type: block.type as BlockType }));
    blockValidator.assertWithinPerTypeCaps([...existing, { type: input.type }]);

    const validated = blockValidator.validate(input.type, input.config, {
      iframeHosts: await cmsCacheService.iframeHosts(),
    });

    await pageBlockRepository.create({
      pageId,
      type: validated.type,
      position: input.position ?? (await pageBlockRepository.nextPosition(pageId)),
      isActive: input.isActive,
      deviceVisibility: input.deviceVisibility,
      configJson: JSON.stringify(validated.config),
      rawConfigJson: validated.rawConfig ? JSON.stringify(validated.rawConfig) : null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      anchorId: input.anchorId ?? null,
      cssClass: input.cssClass ?? null,
    });

    return this.afterBlockChange(pageId);
  },

  async updateBlock(
    pageId: string,
    blockId: string,
    input: BlockUpdateInput,
  ): Promise<PageWithBlocks> {
    const block = await pageBlockRepository.findById(blockId);
    if (!block || block.pageId !== pageId) throw AppError.notFound('Block not found', { blockId });

    const type = (input.type ?? block.type) as BlockType;
    const data: Record<string, unknown> = {
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.deviceVisibility ? { deviceVisibility: input.deviceVisibility } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt ?? null } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt ?? null } : {}),
      ...(input.anchorId !== undefined ? { anchorId: input.anchorId ?? null } : {}),
      ...(input.cssClass !== undefined ? { cssClass: input.cssClass ?? null } : {}),
      ...(input.type ? { type } : {}),
    };

    if (input.config !== undefined || input.type) {
      const source = input.config ?? blockConfig.parse(block.configJson, {});
      const validated = blockValidator.validate(type, source, {
        iframeHosts: await cmsCacheService.iframeHosts(),
      });

      data.configJson = JSON.stringify(validated.config);
      data.rawConfigJson = validated.rawConfig ? JSON.stringify(validated.rawConfig) : null;
    }

    await pageBlockRepository.update(blockId, data);

    return this.afterBlockChange(pageId);
  },

  async removeBlock(pageId: string, blockId: string): Promise<PageWithBlocks> {
    const block = await pageBlockRepository.findById(blockId);
    if (!block || block.pageId !== pageId) throw AppError.notFound('Block not found', { blockId });

    await pageBlockRepository.remove(blockId);

    return this.afterBlockChange(pageId);
  },

  async reorderBlocks(pageId: string, input: BlockReorderInput): Promise<PageWithBlocks> {
    await this.get(pageId);
    await pageBlockRepository.reorder(pageId, input.order);

    return this.afterBlockChange(pageId);
  },

  async afterBlockChange(pageId: string): Promise<PageWithBlocks> {
    const page = await this.get(pageId);
    await this.syncPageMedia(page);
    await cmsCacheService.invalidatePages();
    return page;
  },

  /** One MediaUsage sync per page, covering the page's own media and every block's. */
  async syncPageMedia(page: PageWithBlocks): Promise<void> {
    const fromBlocks = page.blocks.flatMap((block) => {
      const config = blockConfig.parse(block.configJson, {});
      try {
        return blockValidator.validate(block.type, config).mediaIds;
      } catch {
        // An unknown or invalid stored block must not stop the rest of the page syncing.
        return [];
      }
    });

    const ids = [
      ...new Set([page.heroMediaId, page.ogMediaId, ...fromBlocks].filter((id): id is string => Boolean(id))),
    ];

    await mediaUsageService.sync('CMS_PAGE', page.id, ids);
  },

  /* ------------------------------------------------------- publish gate */

  /**
   * Every reason this page cannot be shown to customers, collected in one pass.
   *
   * Mirrors the product publish gate (PROJECT_CONTEXT): the save-time schema lets an editor store
   * half-finished work; this gate is what decides the work is finished.
   */
  async publishBlockers(page: PageWithBlocks): Promise<
    { code: string; blockId?: string; blockType?: string; detail?: unknown }[]
  > {
    const blockers: { code: string; blockId?: string; blockType?: string; detail?: unknown }[] = [];

    if (page.blocks.length === 0) blockers.push({ code: 'NO_BLOCKS' });
    if (!page.title.trim()) blockers.push({ code: 'NO_TITLE' });

    const validated: ValidatedBlock[] = [];

    for (const block of page.blocks) {
      if (!block.isActive) continue;

      const config = blockConfig.parse(block.configJson, {});

      try {
        validated.push(blockValidator.validate(block.type, config, { forPublish: true }));
      } catch (error) {
        blockers.push({
          code: 'BLOCK_INCOMPLETE',
          blockId: block.id,
          blockType: block.type,
          detail: error instanceof AppError ? error.details : String(error),
        });
      }
    }

    if (validated.length > 0) {
      try {
        await blockValidator.assertReferencesExist(validated);
      } catch (error) {
        blockers.push({
          code: 'BLOCK_REFERENCE_MISSING',
          detail: error instanceof AppError ? error.details : String(error),
        });
      }
    }

    return blockers;
  },

  async publish(id: string, actor: Actor): Promise<PageWithBlocks> {
    const page = await this.get(id);
    const blockers = await this.publishBlockers(page);

    if (blockers.length > 0) {
      throw new AppError(422, 'PAGE_NOT_PUBLISHABLE', 'This page is not ready to be published', {
        blockers,
      });
    }

    await this.writeRevision(page, actor, 'published');

    await pageRepository.update(id, {
      status: 'PUBLISHED',
      publishedAt: page.publishedAt ?? new Date(),
      scheduledAt: null,
      lastEditedById: actor.actorId,
    });

    await cmsCacheService.invalidatePages();

    return this.get(id);
  },

  async unpublish(id: string, actor: Actor): Promise<PageWithBlocks> {
    await this.get(id);

    await pageRepository.update(id, { status: 'DRAFT', lastEditedById: actor.actorId });
    await cmsCacheService.invalidatePages();

    return this.get(id);
  },

  async schedule(id: string, input: PageScheduleInput, actor: Actor): Promise<PageWithBlocks> {
    const page = await this.get(id);
    const blockers = await this.publishBlockers(page);

    if (blockers.length > 0) {
      throw new AppError(422, 'PAGE_NOT_PUBLISHABLE', 'This page is not ready to be scheduled', {
        blockers,
      });
    }

    await pageRepository.update(id, {
      status: 'SCHEDULED',
      scheduledAt: input.scheduledAt,
      publishedAt: input.scheduledAt,
      expiresAt: input.expiresAt ?? null,
      lastEditedById: actor.actorId,
    });

    await cmsCacheService.invalidatePages();

    return this.get(id);
  },

  /* --------------------------------------------------------- revisions */

  listRevisions(pageId: string) {
    return pageRevisionRepository.listForPage(pageId);
  },

  toSnapshot(page: PageWithBlocks): PageSnapshot {
    return {
      slug: page.slug,
      title: page.title,
      type: page.type,
      template: page.template,
      excerpt: page.excerpt,
      heroMediaId: page.heroMediaId,
      ogMediaId: page.ogMediaId,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      seoKeywords: page.seoKeywords,
      canonicalUrl: page.canonicalUrl,
      noIndex: page.noIndex,
      blocks: page.blocks.map((block) => ({
        type: block.type,
        position: block.position,
        isActive: block.isActive,
        deviceVisibility: block.deviceVisibility,
        configJson: block.configJson,
        rawConfigJson: block.rawConfigJson,
        startsAt: block.startsAt?.toISOString() ?? null,
        endsAt: block.endsAt?.toISOString() ?? null,
        anchorId: block.anchorId,
        cssClass: block.cssClass,
      })),
    };
  },

  async writeRevision(page: PageWithBlocks, actor: Actor, note: string): Promise<number> {
    const version = await pageRevisionRepository.nextVersion(page.id);

    await pageRevisionRepository.create({
      pageId: page.id,
      version,
      snapshotJson: JSON.stringify(this.toSnapshot(page)),
      editedById: actor.actorId,
      editedByName: actor.actorName,
      note,
    });

    const pruned = await pageRevisionRepository.prune(page.id, env.CMS_MAX_REVISIONS);
    if (pruned > 0) logger.debug({ pageId: page.id, pruned }, 'cms: pruned old page revisions');

    return version;
  },

  /**
   * Restoring writes a NEW revision rather than rewinding to an old one, so the history stays
   * append-only and "who changed it back, and when" remains answerable.
   */
  async restoreRevision(pageId: string, version: number, actor: Actor): Promise<PageWithBlocks> {
    const current = await this.get(pageId);
    const revision = await pageRevisionRepository.find(pageId, version);

    if (!revision) throw AppError.notFound('Revision not found', { pageId, version });

    const restored = snapshot.parse(revision.snapshotJson, null as unknown as PageSnapshot);
    if (!restored) throw AppError.validation('That revision is unreadable', { pageId, version });

    // Snapshot what is there NOW before overwriting it, or the restore is unreversible.
    await this.writeRevision(current, actor, `before restoring v${version}`);

    if (restored.slug !== current.slug) {
      await this.assertSlugFree(restored.slug, pageId);
      await slugRedirectService.recordSlugChange('PAGE', pageId, current.slug, restored.slug);
    }

    await pageRepository.update(pageId, {
      slug: restored.slug,
      title: restored.title,
      type: restored.type,
      template: restored.template,
      excerpt: restored.excerpt,
      heroMediaId: restored.heroMediaId,
      ogMediaId: restored.ogMediaId,
      seoTitle: restored.seoTitle,
      seoDescription: restored.seoDescription,
      seoKeywords: restored.seoKeywords,
      canonicalUrl: restored.canonicalUrl,
      noIndex: restored.noIndex,
      lastEditedById: actor.actorId,
    });

    await pageBlockRepository.replaceAll(
      pageId,
      restored.blocks.map((block) => ({
        pageId,
        type: block.type,
        position: block.position,
        isActive: block.isActive,
        deviceVisibility: block.deviceVisibility,
        configJson: block.configJson,
        rawConfigJson: block.rawConfigJson,
        startsAt: block.startsAt ? new Date(block.startsAt) : null,
        endsAt: block.endsAt ? new Date(block.endsAt) : null,
        anchorId: block.anchorId,
        cssClass: block.cssClass,
      })),
    );

    await this.writeRevision(await this.get(pageId), actor, `restored v${version}`);

    return this.afterBlockChange(pageId);
  },

  /* --------------------------------------------------------- duplicate */

  async duplicate(id: string, input: PageDuplicateInput, actor: Actor): Promise<PageWithBlocks> {
    const source = await this.get(id);
    await this.assertSlugFree(input.slug, null);

    // A copy starts unpublished and with no history of its own: it has not been anywhere yet.
    const copy = await pageRepository.create({
      slug: input.slug,
      title: input.title,
      type: source.type,
      status: 'DRAFT',
      template: source.template,
      excerpt: source.excerpt,
      heroMediaId: source.heroMediaId,
      ogMediaId: source.ogMediaId,
      seoTitle: source.seoTitle,
      seoDescription: source.seoDescription,
      seoKeywords: source.seoKeywords,
      canonicalUrl: null,
      noIndex: source.noIndex,
      isSystem: false,
      authorId: actor.actorId,
      lastEditedById: actor.actorId,
    });

    if (source.blocks.length > 0) {
      await pageBlockRepository.replaceAll(
        copy.id,
        source.blocks.map((block) => ({
          pageId: copy.id,
          type: block.type,
          position: block.position,
          isActive: block.isActive,
          deviceVisibility: block.deviceVisibility,
          configJson: block.configJson,
          rawConfigJson: block.rawConfigJson,
          startsAt: block.startsAt,
          endsAt: block.endsAt,
          anchorId: block.anchorId,
          cssClass: block.cssClass,
        })),
      );
    }

    return this.afterBlockChange(copy.id);
  },

  /** Is this page visible to the public right now? */
  isLive(page: { status: string; publishedAt: Date | null; expiresAt: Date | null }, now = new Date()): boolean {
    const status = page.status as PageStatus;

    if (status === 'PUBLISHED') {
      if (page.expiresAt && page.expiresAt <= now) return false;
      return !page.publishedAt || page.publishedAt <= now;
    }

    if (status === 'SCHEDULED') {
      if (!page.publishedAt || page.publishedAt > now) return false;
      return !page.expiresAt || page.expiresAt > now;
    }

    return false;
  },
};
