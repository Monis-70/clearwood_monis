import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { signKey } from './keys';
import {
  normaliseStorageKey,
  type ListResult,
  type PutOptions,
  type PutResult,
  type StatResult,
  type StorageDriver,
} from './storage.driver';

export interface LocalStorageOptions {
  uploadDir: string;
  publicBaseUrl: string;
  /** Base for HMAC-signed URLs, e.g. http://localhost:7180/media-signed */
  signedBaseUrl: string;
  signingSecret: string;
  defaultSignedTtlSeconds: number;
}

/** Writes under LOCAL_UPLOAD_DIR and serves through the static `/media` mount in app.ts. */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  readonly supportsPresignedUpload = false;

  private readonly root: string;

  constructor(private readonly options: LocalStorageOptions) {
    this.root = path.resolve(options.uploadDir);
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | string,
    _options: PutOptions = {},
  ): Promise<PutResult> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array | string);
    await fs.writeFile(target, buffer);

    const normalised = normaliseStorageKey(key);
    return { key: normalised, url: this.url(normalised), size: buffer.byteLength };
  }

  async putStream(key: string, body: Readable, _options: PutOptions = {}): Promise<PutResult> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(body, createWriteStream(target));

    const normalised = normaliseStorageKey(key);
    const stats = await fs.stat(target);
    return { key: normalised, url: this.url(normalised), size: stats.size };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolve(key);
    await fs.access(target);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deleteMany(keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (await this.exists(key)) {
        await this.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    const target = this.resolve(targetKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(this.resolve(sourceKey), target);
  }

  async move(sourceKey: string, targetKey: string): Promise<void> {
    const target = this.resolve(targetKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(this.resolve(sourceKey), target);
  }

  async list(prefix: string): Promise<ListResult> {
    const cleaned = prefix.replace(/^\/+/, '');
    const keys: string[] = [];

    const walk = async (relative: string): Promise<void> => {
      const absolute = path.join(this.root, relative);
      let entries;
      try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(childRelative);
        } else if (childRelative.startsWith(cleaned)) {
          keys.push(childRelative);
        }
      }
    };

    // Start from the deepest existing directory in the prefix to avoid scanning the whole root.
    const prefixDir = cleaned.includes('/') ? cleaned.slice(0, cleaned.lastIndexOf('/')) : '';
    await walk(prefixDir);

    return { keys: keys.sort(), truncated: false };
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const stats = await fs.stat(this.resolve(key));
      return {
        key: normaliseStorageKey(key),
        size: stats.size,
        contentType: null,
        lastModified: stats.mtime,
        etag: null,
      };
    } catch {
      return null;
    }
  }

  url(key: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}/${normaliseStorageKey(key)}`;
  }

  /** HMAC-signed local URL, verified by the /media-signed/:key route. */
  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    const normalised = normaliseStorageKey(key);
    const expires = Date.now() + (ttlSeconds ?? this.options.defaultSignedTtlSeconds) * 1000;
    const signature = signKey(normalised, expires, this.options.signingSecret);

    return `${this.options.signedBaseUrl.replace(/\/+$/, '')}/${normalised}?expires=${expires}&signature=${signature}`;
  }

  /** Second line of defence against traversal: the resolved path must stay inside the root. */
  private resolve(key: string): string {
    const target = path.resolve(this.root, normaliseStorageKey(key));
    const relative = path.relative(this.root, target);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('storage key escapes the storage root');
    }
    return target;
  }
}
