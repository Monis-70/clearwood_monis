import type { Request, Response } from 'express';

import type {
  MediaBulkDeleteInput,
  MediaFolderCreateInput,
  MediaFolderUpdateInput,
  MediaListQuery,
  MediaPresignInput,
  MediaUpdateInput,
  ProductMediaAttachInput,
  ProductMediaReorderInput,
  ProductMediaUpdateInput,
} from '@shared/schemas/media';
import type { IdParam } from '@shared/schemas/common';

import { storage } from '../container';
import { S3StorageDriver } from '../drivers/storage';
import { buildStorageKey } from '../drivers/storage';
import { auditService } from '../modules/auth/audit.service';
import { galleryResolver } from '../modules/media/gallery.resolver';
import { mediaFolderService } from '../modules/media/mediaFolder.service';
import { mediaService } from '../modules/media/media.service';
import { productMediaService } from '../modules/media/product-media.service';
import { AppError } from '../utils/AppError';
import { ok, paginated } from '../utils/response';

/** R1 — thin controllers. Every write is audited through auditService (Prompt 3). */
export const adminMediaController = {
  config(_req: Request, res: Response): void {
    ok(res, mediaService.config());
  },

  async upload(req: Request, res: Response): Promise<void> {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw AppError.validation('No files were uploaded', { field: 'files' });

    const meta = req.body as {
      folderId?: string;
      folderPath?: string;
      altText?: string;
      title?: string;
      tags?: string;
    };

    const tags = meta.tags
      ? meta.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : undefined;

    const results = [];
    for (const file of files) {
      const result = await mediaService.upload({
        buffer: file.buffer,
        originalName: file.originalname,
        declaredMimeType: file.mimetype,
        ...(meta.folderId ? { folderId: meta.folderId } : {}),
        ...(meta.folderPath ? { folderPath: meta.folderPath } : {}),
        ...(meta.altText ? { altText: meta.altText } : {}),
        ...(meta.title ? { title: meta.title } : {}),
        ...(tags ? { tags } : {}),
        source: 'ADMIN_UPLOAD',
        uploadedByType: req.auth?.principalType ?? null,
        uploadedById: req.auth?.principalId ?? null,
      });

      results.push(result);

      void auditService.recordFromRequest(req, {
        action: 'CREATE',
        entity: 'Media',
        entityId: result.media.id,
        meta: {
          originalName: result.media.originalName,
          sizeBytes: result.media.sizeBytes,
          deduplicated: result.deduplicated,
        },
      });
    }

    ok(res, { uploaded: results }, { count: results.length }, 201);
  },

  /** Direct-to-bucket uploads only make sense on S3; the local driver answers 501 by design. */
  async presign(req: Request, res: Response): Promise<void> {
    if (!(storage instanceof S3StorageDriver)) {
      throw new AppError(
        501,
        'PRESIGN_NOT_SUPPORTED',
        `The "${storage.name}" storage driver cannot issue presigned uploads — POST the file to /admin/media/upload instead`,
        { driver: storage.name },
      );
    }

    const input = req.body as MediaPresignInput;
    const key = buildStorageKey({
      id: crypto.randomUUID(),
      folderPath: input.folderPath ?? 'uploads',
      originalName: input.fileName,
      mimeType: input.contentType,
    });

    ok(res, await storage.presignedUploadUrl(key, input.contentType));
  },

  async list(req: Request, res: Response): Promise<void> {
    const page = await mediaService.list(req.query as unknown as MediaListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await mediaService.get((req.params as unknown as IdParam).id));
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = await mediaService.get(id);
    const updated = await mediaService.update(id, req.body as MediaUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Media',
      entityId: id,
      changes: auditService.diff(
        {
          altText: before.altText,
          title: before.title,
          tags: before.tags,
          folderId: before.folderId,
        },
        {
          altText: updated.altText,
          title: updated.title,
          tags: updated.tags,
          folderId: updated.folderId,
        },
      ),
    });

    ok(res, updated);
  },

  async replace(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const file = (req.files as Express.Multer.File[] | undefined)?.[0];
    if (!file) throw AppError.validation('No replacement file was uploaded', { field: 'files' });

    const updated = await mediaService.replace(id, {
      buffer: file.buffer,
      originalName: file.originalname,
    });

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Media',
      entityId: id,
      severity: 'NOTICE',
      meta: { replacedWith: file.originalname },
    });

    ok(res, updated);
  },

  async reprocess(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const updated = await mediaService.reprocess(id);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Media',
      entityId: id,
      meta: { reprocessed: true, variants: updated.variants.length },
    });

    ok(res, updated);
  },

  async softDelete(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await mediaService.softDelete(id);

    void auditService.recordFromRequest(req, { action: 'DELETE', entity: 'Media', entityId: id });
    ok(res, { deleted: true });
  },

  async restore(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const restored = await mediaService.restore(id);

    void auditService.recordFromRequest(req, { action: 'RESTORE', entity: 'Media', entityId: id });
    ok(res, restored);
  },

  async hardDelete(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { force } = req.query as unknown as { force: boolean };

    const result = await mediaService.hardDelete(id, force);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Media',
      entityId: id,
      severity: 'CRITICAL',
      meta: { permanent: true, force, ...result },
    });

    ok(res, { deleted: true, ...result });
  },

  async bulkDelete(req: Request, res: Response): Promise<void> {
    const { ids } = req.body as MediaBulkDeleteInput;
    const deleted = await mediaService.bulkSoftDelete(ids);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Media',
      entityId: null,
      severity: 'WARNING',
      meta: { bulk: true, requested: ids.length, deleted },
    });

    ok(res, { deleted });
  },

  async garbageCollect(_req: Request, res: Response): Promise<void> {
    ok(res, await mediaService.garbageCollect(true));
  },

  /* ------------------------------------------------------------ folders */

  async listFolders(_req: Request, res: Response): Promise<void> {
    ok(res, await mediaFolderService.tree());
  },

  async createFolder(req: Request, res: Response): Promise<void> {
    const folder = await mediaFolderService.create(req.body as MediaFolderCreateInput);

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'MediaFolder',
      entityId: folder.id,
      meta: { path: folder.path },
    });

    ok(res, folder, null, 201);
  },

  async updateFolder(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const folder = await mediaFolderService.update(id, req.body as MediaFolderUpdateInput);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'MediaFolder',
      entityId: id,
      meta: { path: folder.path },
    });

    ok(res, folder);
  },

  async deleteFolder(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await mediaFolderService.remove(id);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'MediaFolder',
      entityId: id,
    });

    ok(res, { deleted: true });
  },
};

export const productMediaController = {
  async list(req: Request, res: Response): Promise<void> {
    const { productId } = req.params as unknown as { productId: string };
    ok(res, await productMediaService.list(productId));
  },

  async attach(req: Request, res: Response): Promise<void> {
    const { productId } = req.params as unknown as { productId: string };
    const attached = await productMediaService.attach(
      productId,
      req.body as ProductMediaAttachInput,
    );

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: productId,
      meta: { gallery: 'attach', mediaIds: attached.map((item) => item.mediaId) },
    });

    ok(res, attached, null, 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { productId, id } = req.params as unknown as { productId: string; id: string };
    const updated = await productMediaService.update(
      productId,
      id,
      req.body as ProductMediaUpdateInput,
    );

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: productId,
      meta: { gallery: 'update', productMediaId: id },
    });

    ok(res, updated);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    const { productId } = req.params as unknown as { productId: string };
    const items = await productMediaService.reorder(
      productId,
      req.body as ProductMediaReorderInput,
    );

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: productId,
      meta: { gallery: 'reorder', count: items.length },
    });

    ok(res, items);
  },

  async detach(req: Request, res: Response): Promise<void> {
    const { productId, id } = req.params as unknown as { productId: string; id: string };
    await productMediaService.detach(productId, id);

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Product',
      entityId: productId,
      meta: { gallery: 'detach', productMediaId: id },
    });

    ok(res, { detached: true });
  },
};

export const publicMediaController = {
  async gallery(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as { slug: string };
    ok(res, await galleryResolver.resolveBySlug(slug, req.query));
  },
};
