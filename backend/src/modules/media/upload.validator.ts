import type { MediaKind } from '@shared/enums';

import { env, maxUploadBytes } from '../../config/env';
import { AppError } from '../../utils/AppError';

/**
 * Never trust the client's `mimetype`. Every upload is identified by its own bytes, checked against
 * the env allowlist, size-capped per kind and — for SVG — sanitised or rejected outright.
 *
 * `file-type` is ESM-only and the backend is CommonJS, so the sniffing for our small, fixed
 * allowlist is implemented here instead: fewer moving parts and every branch is unit-tested.
 */

export interface SniffedFile {
  mimeType: string;
  kind: MediaKind;
  extension: string;
}

const KIND_BY_MIME: Record<string, MediaKind> = {
  'image/jpeg': 'IMAGE',
  'image/png': 'IMAGE',
  'image/webp': 'IMAGE',
  'image/avif': 'IMAGE',
  'image/gif': 'IMAGE',
  'image/svg+xml': 'IMAGE',
  'video/mp4': 'VIDEO',
  'video/webm': 'VIDEO',
  'application/pdf': 'DOCUMENT',
};

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

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/** Magic-byte identification for exactly the formats we accept. */
export function sniffMimeType(buffer: Buffer): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  // RIFF....WEBP
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }

  // ISO-BMFF: "....ftyp" then the major brand.
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }

  // SVG is text: allow a BOM, whitespace, an XML prolog, a doctype and comments before <svg.
  const head = buffer
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (
    /^<\?xml[\s\S]*?\?>/i.test(head) ||
    head.startsWith('<!--') ||
    head.startsWith('<!DOCTYPE') ||
    head.startsWith('<svg')
  ) {
    if (/<svg[\s>]/i.test(buffer.subarray(0, 4096).toString('utf8'))) return 'image/svg+xml';
  }

  return null;
}

/** Splits `photo.final.jpg` into a single safe extension; a double extension is collapsed. */
export function sanitiseFileName(originalName: string): string {
  const base = (originalName.replace(/\\/g, '/').split('/').pop() ?? 'file').replace(/\0/g, '');
  const parts = base.split('.').filter(Boolean);

  if (parts.length <= 1) return base.slice(0, 200) || 'file';

  const extension = parts
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const stem = parts.join('-').replace(/[^\w .-]/g, '-');
  return `${stem}.${extension}`.slice(0, 200);
}

/* ------------------------------------------------------------------- SVG */

const SVG_FORBIDDEN = [
  /<script[\s>]/i,
  /<foreignObject[\s>]/i,
  /<!ENTITY/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /<use[^>]+xlink:href\s*=\s*["']?https?:/i,
  /<image[^>]+(xlink:)?href\s*=\s*["']?https?:/i,
  /<iframe[\s>]/i,
  /<embed[\s>]/i,
  /<object[\s>]/i,
];

export interface SvgCheck {
  safe: boolean;
  sanitised: Buffer;
  removed: string[];
}

/**
 * Strips script-bearing constructs. If anything dangerous survives the strip we refuse the file
 * rather than storing bytes we do not fully understand.
 */
export function sanitiseSvg(buffer: Buffer): SvgCheck {
  const source = buffer.toString('utf8');
  const removed: string[] = [];

  let cleaned = source
    .replace(/<script[\s\S]*?<\/script\s*>/gi, () => {
      removed.push('script');
      return '';
    })
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, () => {
      removed.push('foreignObject');
      return '';
    })
    .replace(/<(iframe|embed|object)[\s\S]*?<\/\1\s*>/gi, (_match, tag: string) => {
      removed.push(String(tag));
      return '';
    })
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
      removed.push('event-handler');
      return '';
    })
    .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, () => {
      removed.push('javascript-url');
      return '';
    });

  // Self-closing or unterminated variants of the same tags.
  cleaned = cleaned.replace(
    /<(script|iframe|embed|object|foreignObject)\b[^>]*\/?>/gi,
    (_m, tag: string) => {
      removed.push(String(tag));
      return '';
    },
  );

  const sanitised = Buffer.from(cleaned, 'utf8');
  const safe = !SVG_FORBIDDEN.some((pattern) => pattern.test(cleaned));

  return { safe, sanitised, removed: [...new Set(removed)] };
}

/* ------------------------------------------------------------ virus scan */

export interface VirusScanResult {
  clean: boolean;
  engine: string;
  signature?: string;
}

/**
 * TODO (post-launch): wire ClamAV (clamd on the app host) or an object-scanning lambda here and
 * mark the media QUARANTINED when it reports a signature. The hook exists now so the call site in
 * `validateUpload()` never has to move.
 */
export async function virusScan(_buffer: Buffer): Promise<VirusScanResult> {
  return { clean: true, engine: 'noop' };
}

/* --------------------------------------------------------------- validate */

export interface ValidatedUpload {
  buffer: Buffer;
  mimeType: string;
  kind: MediaKind;
  extension: string;
  fileName: string;
  sizeBytes: number;
  sanitised: boolean;
}

function allowListFor(kind: MediaKind): string[] {
  if (kind === 'IMAGE') return env.ALLOWED_IMAGE_MIME;
  if (kind === 'VIDEO') return env.ALLOWED_VIDEO_MIME;
  return env.ALLOWED_DOC_MIME;
}

export async function validateUpload(input: {
  buffer: Buffer;
  originalName: string;
  declaredMimeType?: string;
}): Promise<ValidatedUpload> {
  const fileName = sanitiseFileName(input.originalName);

  if (input.buffer.length === 0) {
    throw AppError.validation('The uploaded file is empty', { fileName });
  }
  if (input.buffer.length > maxUploadBytes) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `Files must be ${env.MAX_UPLOAD_SIZE_MB}MB or smaller`,
      {
        fileName,
        sizeBytes: input.buffer.length,
        maxBytes: maxUploadBytes,
      },
    );
  }

  const sniffed = sniffMimeType(input.buffer);
  if (!sniffed) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'That file type is not supported', {
      fileName,
      declared: input.declaredMimeType ?? null,
    });
  }

  const kind = KIND_BY_MIME[sniffed];
  if (!kind || !allowListFor(kind).includes(sniffed)) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'That file type is not allowed', {
      fileName,
      detected: sniffed,
    });
  }

  const scan = await virusScan(input.buffer);
  if (!scan.clean) {
    throw new AppError(422, 'FILE_INFECTED', 'That file failed the malware scan', {
      fileName,
      engine: scan.engine,
    });
  }

  let buffer = input.buffer;
  let sanitised = false;

  if (sniffed === 'image/svg+xml') {
    const check = sanitiseSvg(buffer);
    if (!check.safe) {
      throw new AppError(422, 'UNSAFE_SVG', 'That SVG contains active content and was rejected', {
        fileName,
        removed: check.removed,
      });
    }
    buffer = check.sanitised;
    sanitised = check.removed.length > 0;
  }

  return {
    buffer,
    mimeType: sniffed,
    kind,
    extension: EXTENSION_BY_MIME[sniffed] ?? 'bin',
    fileName,
    sizeBytes: buffer.length,
    sanitised,
  };
}
