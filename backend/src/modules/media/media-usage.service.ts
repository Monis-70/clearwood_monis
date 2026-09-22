import type { MediaUsageType } from '@shared/enums';

import { mediaRepository } from '../../repositories/media.repository';
import { mediaUsageRepository } from '../../repositories/mediaUsage.repository';

/**
 * The single source of truth for "where is this asset used". Every attach/detach in this prompt and
 * in Prompts 5/10/11/15 goes through here so `Media.usageCount` stays honest and a hard delete can
 * be blocked safely.
 */

export interface UsageRef {
  mediaId: string;
  usageType: MediaUsageType;
  entityId: string;
  field?: string | null;
}

export const mediaUsageService = {
  async attach(ref: UsageRef): Promise<void> {
    await mediaUsageRepository.attach(ref);
    await this.recountOne(ref.mediaId);
  },

  async detach(ref: UsageRef): Promise<void> {
    await mediaUsageRepository.detach(ref);
    await this.recountOne(ref.mediaId);
  },

  /** Makes the stored usage for one entity+field exactly match `mediaIds`. */
  async sync(
    usageType: MediaUsageType,
    entityId: string,
    mediaIds: string[],
    field: string | null = null,
  ): Promise<void> {
    const existing = await mediaUsageRepository.findForEntity(usageType, entityId);
    const wanted = new Set(mediaIds);
    const touched = new Set<string>(mediaIds);

    for (const row of existing) {
      if (row.field !== field) continue;
      if (!wanted.has(row.mediaId)) {
        await mediaUsageRepository.detach({ mediaId: row.mediaId, usageType, entityId, field });
        touched.add(row.mediaId);
      }
    }

    for (const mediaId of mediaIds) {
      await mediaUsageRepository.attach({ mediaId, usageType, entityId, field });
    }

    for (const mediaId of touched) await this.recountOne(mediaId);
  },

  async detachEntity(usageType: MediaUsageType, entityId: string): Promise<number> {
    const rows = await mediaUsageRepository.findForEntity(usageType, entityId);
    const removed = await mediaUsageRepository.detachAllForEntity(usageType, entityId);

    for (const row of rows) await this.recountOne(row.mediaId);
    return removed;
  },

  async detachMedia(mediaId: string): Promise<number> {
    const removed = await mediaUsageRepository.detachAllForMedia(mediaId);
    await mediaRepository.setUsageCount(mediaId, 0);
    return removed;
  },

  listFor(mediaId: string) {
    return mediaUsageRepository.findForMedia(mediaId);
  },

  isInUse(mediaId: string): Promise<boolean> {
    return mediaUsageRepository.countForMedia(mediaId).then((count) => count > 0);
  },

  async recountOne(mediaId: string): Promise<number> {
    const count = await mediaUsageRepository.countForMedia(mediaId);
    await mediaRepository.setUsageCount(mediaId, count);
    return count;
  },

  /** Full reconciliation — used by the seed and available to an admin repair job. */
  async recountAll(): Promise<number> {
    const counts = await mediaUsageRepository.countsByMedia();
    const all = await mediaRepository.allPaths();
    let updated = 0;

    for (const media of all) {
      const expected = counts.get(media.id) ?? 0;
      const row = await mediaRepository.findById(media.id, true);
      if (row && row.usageCount !== expected) {
        await mediaRepository.setUsageCount(media.id, expected);
        updated += 1;
      }
    }

    return updated;
  },
};
