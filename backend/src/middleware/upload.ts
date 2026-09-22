import multer from 'multer';

import { env, maxUploadBytes } from '../config/env';
import { AppError } from '../utils/AppError';

/**
 * Files are buffered in memory: they are small by policy, and the pipeline needs the whole buffer
 * for magic-byte sniffing, checksumming and sharp. The size cap is enforced here AND again in the
 * validator, because multer's limit only covers what reached this process.
 */
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: env.MAX_UPLOAD_FILES,
    fields: 20,
  },
});

/** Translates multer's own errors into the standard envelope (R3/R4). */
export function toUploadError(error: unknown): unknown {
  if (!(error instanceof multer.MulterError)) return error;

  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(
        413,
        'FILE_TOO_LARGE',
        `Files must be ${env.MAX_UPLOAD_SIZE_MB}MB or smaller`,
        { maxBytes: maxUploadBytes },
      );
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return AppError.validation(`Upload at most ${env.MAX_UPLOAD_FILES} files at a time`, {
        maxFiles: env.MAX_UPLOAD_FILES,
        field: error.field ?? null,
      });
    default:
      return AppError.validation(error.message, { code: error.code });
  }
}
