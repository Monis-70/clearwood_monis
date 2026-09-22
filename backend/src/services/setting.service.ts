import type { AppSetting } from '@prisma/client';

import type { JsonValue } from '@shared/types/api';

import { cache } from '../container';
import { settingRepository } from '../repositories/setting.repository';
import { jsonColumn } from '../utils/jsonColumn';

export type PublicSettings = Record<string, JsonValue>;

const CACHE_PREFIX = 'settings:';
const TTL_SECONDS = 60;

const jsonSetting = jsonColumn<JsonValue>(undefined, 'AppSetting.value');

/** D3 — `value` is a String column; `valueType` tells us how to hand it to the client. */
function decode(setting: AppSetting): JsonValue {
  switch (setting.valueType) {
    case 'number': {
      const parsed = Number(setting.value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case 'boolean':
      return setting.value === 'true' || setting.value === '1';
    case 'json':
      return jsonSetting.parse(setting.value, null);
    case 'string':
    default:
      return setting.value;
  }
}

export const settingService = {
  /** Flat `{ "site.name": "ClearWood Furnitures", ... }` map of every public setting. */
  async getPublicSettings(group?: string): Promise<PublicSettings> {
    const key = `${CACHE_PREFIX}public:${group ?? 'all'}`;

    return cache.wrap(key, TTL_SECONDS, async () => {
      const rows = await settingRepository.findPublic(group);
      return rows.reduce<PublicSettings>((accumulator, row) => {
        accumulator[row.key] = decode(row);
        return accumulator;
      }, {});
    });
  },

  /** One setting, decoded. Returns null when the key has never been seeded or set. */
  async getValue(key: string): Promise<JsonValue | null> {
    const cacheKey = `${CACHE_PREFIX}one:${key}`;

    return cache.wrap(cacheKey, TTL_SECONDS, async () => {
      const row = await settingRepository.findByKey(key);
      return row ? decode(row) : null;
    });
  },

  /** Every setting in a group, decoded. Used by the CMS content-settings screen. */
  async getGroup(group: string): Promise<PublicSettings> {
    const rows = await settingRepository.findByGroup(group);

    return rows.reduce<PublicSettings>((accumulator, row) => {
      accumulator[row.key] = decode(row);
      return accumulator;
    }, {});
  },

  /** Called by admin writes from Prompt 5 so the storefront picks changes up immediately (R9). */
  async invalidate(): Promise<void> {
    await cache.delByPrefix(CACHE_PREFIX);
  },
};
