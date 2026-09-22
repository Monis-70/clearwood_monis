import { Readable } from 'node:stream';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  normaliseStorageKey,
  type ListResult,
  type PutOptions,
  type PutResult,
  type StatResult,
  type StorageDriver,
} from './storage.driver';

/** Anything larger goes through a multipart upload rather than a single PutObject. */
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  prefix: string;
  publicBaseUrl: string;
  /** Overrides publicBaseUrl when a CDN sits in front of the bucket. */
  cdnBaseUrl?: string;
  acl: 'private' | 'public-read';
  forcePathStyle: boolean;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  defaultSignedTtlSeconds: number;
  /** Injected in tests so the driver is exercised without network access. */
  client?: S3Client;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  readonly supportsPresignedUpload = true;

  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = options.client ?? new S3Client(this.clientConfig());
  }

  private clientConfig(): S3ClientConfig {
    return {
      region: this.options.region,
      forcePathStyle: this.options.forcePathStyle,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.accessKeyId && this.options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: this.options.accessKeyId,
              secretAccessKey: this.options.secretAccessKey,
            },
          }
        : {}),
    };
  }

  /** The bucket key: the configured prefix plus the storage key. */
  private objectKey(key: string): string {
    const normalised = normaliseStorageKey(key);
    const prefix = this.options.prefix.replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${normalised}` : normalised;
  }

  private writeParams(key: string, options: PutOptions) {
    return {
      Bucket: this.options.bucket,
      Key: this.objectKey(key),
      ContentType: options.contentType,
      CacheControl: options.cacheControl ?? IMMUTABLE_CACHE,
      ServerSideEncryption: 'AES256' as const,
      ACL: this.options.acl,
      ...(options.metadata ? { Metadata: options.metadata } : {}),
    };
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | string,
    options: PutOptions = {},
  ): Promise<PutResult> {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array | string);

    if (buffer.byteLength > MULTIPART_THRESHOLD_BYTES) {
      return this.putStream(key, Readable.from(buffer), options);
    }

    await this.client.send(
      new PutObjectCommand({ ...this.writeParams(key, options), Body: buffer }),
    );

    const normalised = normaliseStorageKey(key);
    return { key: normalised, url: this.url(normalised), size: buffer.byteLength };
  }

  async putStream(key: string, body: Readable, options: PutOptions = {}): Promise<PutResult> {
    const upload = new Upload({
      client: this.client,
      params: { ...this.writeParams(key, options), Body: body },
      queueSize: 4,
      partSize: MULTIPART_THRESHOLD_BYTES,
    });

    await upload.done();

    const normalised = normaliseStorageKey(key);
    const stat = await this.stat(normalised);
    return { key: normalised, url: this.url(normalised), size: stat?.size ?? 0 };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
    );
    return Buffer.from(
      await (
        response.Body as { transformToByteArray(): Promise<Uint8Array> }
      ).transformToByteArray(),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
    );
    return response.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
    );
  }

  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    const result = await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.options.bucket,
        Delete: { Objects: keys.map((key) => ({ Key: this.objectKey(key) })), Quiet: true },
      }),
    );
    return keys.length - (result.Errors?.length ?? 0);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        CopySource: `${this.options.bucket}/${this.objectKey(sourceKey)}`,
        Key: this.objectKey(targetKey),
        ServerSideEncryption: 'AES256',
        ACL: this.options.acl,
      }),
    );
  }

  async move(sourceKey: string, targetKey: string): Promise<void> {
    await this.copy(sourceKey, targetKey);
    await this.delete(sourceKey);
  }

  async list(prefix: string): Promise<ListResult> {
    const response = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: this.objectKey(prefix) }),
    );

    const configured = this.options.prefix.replace(/^\/+|\/+$/g, '');
    const keys = (response.Contents ?? [])
      .map((object) => object.Key ?? '')
      .filter(Boolean)
      .map((key) =>
        configured && key.startsWith(`${configured}/`) ? key.slice(configured.length + 1) : key,
      );

    return { keys: keys.sort(), truncated: Boolean(response.IsTruncated) };
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
      );

      return {
        key: normaliseStorageKey(key),
        size: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
        lastModified: response.LastModified ?? null,
        etag: response.ETag ?? null,
      };
    } catch {
      return null;
    }
  }

  url(key: string): string {
    const base = (this.options.cdnBaseUrl ?? this.options.publicBaseUrl).replace(/\/+$/, '');
    return `${base}/${this.objectKey(key)}`;
  }

  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.objectKey(key) }),
      { expiresIn: ttlSeconds ?? this.options.defaultSignedTtlSeconds },
    );
  }

  /** Direct-to-bucket upload ticket used by POST /admin/media/presign. */
  async presignedUploadUrl(
    key: string,
    contentType: string,
    ttlSeconds?: number,
  ): Promise<{ url: string; key: string; headers: Record<string, string> }> {
    const normalised = normaliseStorageKey(key);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.objectKey(normalised),
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        ACL: this.options.acl,
      }),
      { expiresIn: ttlSeconds ?? this.options.defaultSignedTtlSeconds },
    );

    return {
      url,
      key: normalised,
      headers: { 'Content-Type': contentType, 'x-amz-server-side-encryption': 'AES256' },
    };
  }
}
