import type { Readable } from 'node:stream';

import type { StorageDriver as StorageDriverName } from '@shared/enums';

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  /** Extra key/value metadata; the local driver ignores it, S3 stores it. */
  metadata?: Record<string, string>;
}

export interface PutResult {
  key: string;
  url: string;
  size: number;
}

export interface StatResult {
  key: string;
  size: number;
  contentType: string | null;
  lastModified: Date | null;
  etag: string | null;
}

export interface ListResult {
  keys: string[];
  truncated: boolean;
}

/**
 * The complete storage contract. Everything that touches bytes goes through this interface, so the
 * Prompt 17 switch from `local` to `s3` is a config change. Never build a URL by string
 * concatenation anywhere except `url()` / `signedUrl()`.
 */
export interface StorageDriver {
  readonly name: StorageDriverName;
  /** Whether the driver can hand a browser a direct-to-storage upload ticket. */
  readonly supportsPresignedUpload: boolean;
  put(key: string, body: Buffer | Uint8Array | string, options?: PutOptions): Promise<PutResult>;
  putStream(key: string, body: Readable, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  copy(sourceKey: string, targetKey: string): Promise<void>;
  move(sourceKey: string, targetKey: string): Promise<void>;
  list(prefix: string): Promise<ListResult>;
  stat(key: string): Promise<StatResult | null>;
  /** Public URL for a stored object. */
  url(key: string): string;
  /** Time-limited URL for a private object. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

/** Windows refuses these names even with an extension — they would break a local disk store. */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * R10 — object keys come from user input (uploaded file names), so they are normalised and any
 * traversal attempt is rejected before it ever reaches the filesystem or a bucket.
 */
export function normaliseStorageKey(key: string): string {
  const cleaned = key.replace(/\\/g, '/').replace(/^\/+/, '').trim();

  if (!cleaned) {
    throw new Error('storage key must not be empty');
  }
  if (cleaned.includes('\0')) {
    throw new Error('storage key must not contain null bytes');
  }
  if (/(^|\/)\.\.(\/|$)/.test(cleaned)) {
    throw new Error('storage key must not traverse outside the storage root');
  }
  if (/^[A-Za-z]:/.test(cleaned)) {
    throw new Error('storage key must be relative');
  }
  if (cleaned.split('/').some((segment) => RESERVED_WINDOWS_NAMES.test(segment))) {
    throw new Error('storage key must not use a reserved name');
  }
  if (cleaned.length > 900) {
    throw new Error('storage key is too long');
  }

  return cleaned;
}
