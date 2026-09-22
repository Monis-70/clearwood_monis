import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { slugify } from '../../utils/slug';

/**
 * Deterministic, collision-free, CDN-friendly keys:
 *   {folderPath}/{yyyy}/{mm}/{cuid}-{slugified-basename}[-{label}].{ext}
 * Renditions live beside the original with the label suffix, so a whole asset family shares a
 * prefix and can be deleted or copied with one `list()`.
 */

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

export function extensionFor(mimeType: string, fallback = 'bin'): string {
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? fallback;
}

/** Strips any directory component and neutralises `..`, null bytes and double extensions. */
export function safeBaseName(originalName: string): string {
  const withoutPath = originalName.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const withoutNulls = withoutPath.replace(/\0/g, '');
  const stem = withoutNulls.replace(/\.[^.]*$/, '') || 'file';

  try {
    return slugify(stem).slice(0, 60);
  } catch {
    return 'file';
  }
}

export interface BuildKeyInput {
  id: string;
  folderPath: string;
  originalName: string;
  mimeType: string;
  /** Rendition label; omitted for the original. */
  label?: string;
  /** Rendition format extension override, e.g. "webp". */
  extension?: string;
  at?: Date;
}

export function buildStorageKey(input: BuildKeyInput): string {
  const at = input.at ?? new Date();
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');

  const folder = input.folderPath.replace(/^\/+|\/+$/g, '') || 'uploads';
  const base = safeBaseName(input.originalName);
  const suffix = input.label && input.label !== 'ORIGINAL' ? `-${input.label.toLowerCase()}` : '';
  const ext = input.extension ?? extensionFor(input.mimeType);

  return `${folder}/${year}/${month}/${input.id}-${base}${suffix}.${ext}`;
}

/** The shared prefix of an asset and all of its renditions. */
export function keyFamilyPrefix(originalKey: string): string {
  return originalKey.replace(/(-[a-z]+)?\.[^./]+$/, '');
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ----------------------------------------------------------- signed urls */

export function signKey(key: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${key}:${expiresAtMs}`).digest('base64url');
}

export function verifyKeySignature(
  key: string,
  expiresAtMs: number,
  signature: string,
  secret: string,
): { valid: boolean; reason?: 'EXPIRED' | 'BAD_SIGNATURE' } {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { valid: false, reason: 'EXPIRED' };
  }

  const expected = Buffer.from(signKey(key, expiresAtMs, secret));
  const provided = Buffer.from(signature);

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }
  return { valid: true };
}
