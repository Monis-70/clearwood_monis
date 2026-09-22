import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';

import { env } from './config/env';
import { logger } from './config/logger';
import { buildOpenApiDocument } from './docs/openapi';
import { normaliseStorageKey, verifyKeySignature } from './drivers/storage';
import { registerCatalogSubscribers } from './events/subscribers';
import {
  apiRateLimiter,
  errorHandler,
  httpLogger,
  notFound,
  queryCount,
  requestId,
  requestScopeContext,
} from './middleware';
import { asyncHandler } from './middleware';
import { seoRootController } from './controllers/content.controller';
import { apiRouter, healthRouter, webhookRouter } from './routes';
import { AppError } from './utils/AppError';

/** R10 — an explicit allowlist. `*` is never acceptable because we send credentials. */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: curl, the REST Client `.http` files, server-to-server, same-origin.
    if (!origin) return callback(null, true);

    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);

    callback(new AppError(403, 'CORS_ORIGIN_NOT_ALLOWED', `Origin ${origin} is not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-CSRF-Token',
    // Without this the browser cannot send the key at all, and a retried checkout would place a
    // second order.
    'Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 600,
};

const swaggerCustomCss = `
  .swagger-ui .topbar { display: none }
  .swagger-ui { font-family: Inter, system-ui, sans-serif }
  body { background: #FAF7F2 }
  .swagger-ui .info .title { font-family: Fraunces, "Playfair Display", Georgia, serif; color: #1E1A16 }
  .swagger-ui .info .title small.version-stamp { background-color: #B4613A }
  .swagger-ui .scheme-container { background: #FFFFFF; box-shadow: 0 10px 30px rgba(30,26,22,.08); border-radius: 14px }
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #8A5A3B }
  .swagger-ui .btn.execute { background-color: #B4613A; border-color: #B4613A }
`;

export function createApp(): Express {
  const app = express();

  // Cache invalidation and search reindexing both hang off the catalog event bus (Prompt 7).
  registerCatalogSubscribers();

  app.disable('x-powered-by');

  app.use(requestId);
  app.use(requestScopeContext);
  app.use(queryCount);
  app.use(httpLogger);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cors(corsOptions));
  app.use(compression());

  /*
   * Payment webhooks are mounted BEFORE the JSON parser and with `express.raw`, because the HMAC
   * is computed over the exact bytes the provider sent. Re-serialising parsed JSON would change
   * key order and whitespace and break every signature. This is the only route with raw bodies.
   */
  app.use(
    '/api/v1/webhooks',
    express.raw({ type: '*/*', limit: '1mb' }),
    cookieParser(),
    webhookRouter,
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(hpp());
  app.use(cookieParser());

  // Static media for STORAGE_DRIVER=local; the S3 driver serves from its own CDN base URL.
  if (env.STORAGE_DRIVER === 'local') {
    const uploadDir = path.resolve(env.LOCAL_UPLOAD_DIR);
    fs.mkdirSync(uploadDir, { recursive: true });
    app.use(
      '/media',
      express.static(uploadDir, { index: false, dotfiles: 'deny', maxAge: '7d', etag: true }),
    );

    // HMAC-verified counterpart of LocalStorageDriver.signedUrl() — the local stand-in for an
    // S3 presigned GET, so private assets behave the same on both drivers.
    app.get('/media-signed/*', (req, res, next) => {
      const key = String((req.params as Record<string, string>)[0] ?? '');
      const expires = Number(req.query.expires);
      const signature = String(req.query.signature ?? '');

      const check = verifyKeySignature(key, expires, signature, env.MEDIA_SIGNING_SECRET);
      if (!check.valid) {
        next(
          new AppError(
            403,
            check.reason === 'EXPIRED' ? 'SIGNED_URL_EXPIRED' : 'SIGNED_URL_INVALID',
            'This link is no longer valid',
          ),
        );
        return;
      }

      try {
        const target = path.resolve(uploadDir, normaliseStorageKey(key));
        if (path.relative(uploadDir, target).startsWith('..')) throw new Error('escapes root');
        res.sendFile(target, (error) => {
          if (error) next(AppError.notFound('Asset not found', { key }));
        });
      } catch {
        next(AppError.notFound('Asset not found', { key }));
      }
    });
  }

  // R7 — generated spec + branded Swagger UI. Swagger UI needs inline styles/scripts, so the
  // global CSP is relaxed for this path only.
  app.get('/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument());
  });

  app.use(
    '/docs',
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: `${env.APP_NAME} API docs`,
      customCss: swaggerCustomCss,
      swaggerOptions: { url: '/openapi.json', displayRequestDuration: true, docExpansion: 'list' },
    }),
  );

  // Probes stay outside the rate limiter so a monitor can never lock itself out.
  app.use(healthRouter);

  /*
   * Crawlers look for these at the root and nowhere else, so they cannot live under /api/v1.
   * Outside the API rate limiter too: throttling Googlebot is a way to get deindexed.
   */
  app.get('/sitemap.xml', asyncHandler(seoRootController.sitemapIndex));
  app.get('/sitemap-:section.xml', asyncHandler(seoRootController.sitemapSection));
  app.get('/robots.txt', asyncHandler(seoRootController.robots));

  app.use('/api', apiRateLimiter);
  app.use(env.API_PREFIX, apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  logger.debug({ prefix: env.API_PREFIX, origins: env.CORS_ORIGINS }, 'express app created');

  return app;
}
