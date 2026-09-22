import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { LocalStorageDriver } from './local.storage';
import { S3StorageDriver } from './s3.storage';
import type { StorageDriver } from './storage.driver';

export type {
  ListResult,
  PutOptions,
  PutResult,
  StatResult,
  StorageDriver,
} from './storage.driver';
export { normaliseStorageKey } from './storage.driver';
export { LocalStorageDriver } from './local.storage';
export { S3StorageDriver } from './s3.storage';
export {
  buildStorageKey,
  extensionFor,
  keyFamilyPrefix,
  safeBaseName,
  sha256,
  signKey,
  verifyKeySignature,
} from './keys';

/** Derived from PUBLIC_MEDIA_BASE_URL so the signed route lives on the same origin. */
function signedBaseUrl(env: Env): string {
  return env.PUBLIC_MEDIA_BASE_URL.replace(/\/media\/?$/, '/media-signed');
}

export function createStorage(env: Env): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 's3':
      logger.debug({ driver: 's3', bucket: env.S3_BUCKET }, 'storage driver ready');
      return new S3StorageDriver({
        bucket: env.S3_BUCKET!,
        region: env.AWS_REGION!,
        prefix: env.S3_UPLOAD_PREFIX,
        publicBaseUrl: env.S3_PUBLIC_BASE_URL!,
        ...(env.MEDIA_CDN_BASE_URL ? { cdnBaseUrl: env.MEDIA_CDN_BASE_URL } : {}),
        acl: env.S3_ACL,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        ...(env.AWS_ACCESS_KEY_ID ? { accessKeyId: env.AWS_ACCESS_KEY_ID } : {}),
        ...(env.AWS_SECRET_ACCESS_KEY ? { secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : {}),
        defaultSignedTtlSeconds: env.MEDIA_SIGNED_URL_TTL,
      });
    case 'local':
    default:
      logger.debug({ driver: 'local', dir: env.LOCAL_UPLOAD_DIR }, 'storage driver ready');
      return new LocalStorageDriver({
        uploadDir: env.LOCAL_UPLOAD_DIR,
        publicBaseUrl: env.MEDIA_CDN_BASE_URL ?? env.PUBLIC_MEDIA_BASE_URL,
        signedBaseUrl: signedBaseUrl(env),
        signingSecret: env.MEDIA_SIGNING_SECRET,
        defaultSignedTtlSeconds: env.MEDIA_SIGNED_URL_TTL,
      });
  }
}
