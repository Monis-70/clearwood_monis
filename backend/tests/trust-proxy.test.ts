import { execFileSync } from 'node:child_process';
import path from 'node:path';

import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { env, parseTrustProxy } from '../src/config/env';

/**
 * Prompt 2 — TRUST_PROXY decides whose X-Forwarded-For Express believes, and therefore which IP
 * the rate limiter counts and the audit log records. Trusting too much lets any client pick its
 * own IP (and dodge every per-IP limit); trusting nothing behind nginx puts every shopper in one
 * rate-limit bucket.
 */

const backendRoot = path.resolve(__dirname, '..');
const tsxCli = path.resolve(backendRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function echoIp(trust: false | string[]) {
  const app = express();
  app.set('trust proxy', trust);
  app.get('/', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

function limitedToOne(trust: false | string[]) {
  const app = express();
  app.set('trust proxy', trust);
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // The header without a trusted proxy is exactly the scenario under test.
      validate: { xForwardedForHeader: false },
    }),
  );
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('parseTrustProxy', () => {
  it('defaults to trusting nobody', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(env.TRUST_PROXY).toBe(false);
    expect(createApp().get('trust proxy')).toBe(false);
  });

  it('accepts named ranges, addresses and CIDRs', () => {
    expect(parseTrustProxy('loopback')).toEqual(['loopback']);
    expect(parseTrustProxy('loopback, 10.0.0.0/8 ,::1')).toEqual(['loopback', '10.0.0.0/8', '::1']);
    expect(parseTrustProxy('uniquelocal,linklocal,fd00::/8')).toEqual([
      'uniquelocal',
      'linklocal',
      'fd00::/8',
    ]);
  });

  it('refuses anything that would trust an arbitrary network', () => {
    for (const value of [
      'true',
      '*',
      '1',
      '2',
      '0.0.0.0/0',
      '::/0',
      '10.0.0.0/33',
      'proxy',
      '10.0.0.1/8/1',
    ]) {
      expect(() => parseTrustProxy(value), value).toThrow(/not allowed/);
    }
  });

  it('stops the process from booting with TRUST_PROXY=true', () => {
    let status = 0;
    let output = '';
    try {
      execFileSync(process.execPath, [tsxCli, '-e', "import('./src/config/env')"], {
        cwd: backendRoot,
        env: { ...process.env, NODE_ENV: 'test', TRUST_PROXY: 'true' },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    expect(status).not.toBe(0);
    expect(output).toContain('TRUST_PROXY');
  }, 60_000);
});

describe('client IP behind a proxy', () => {
  it('ignores X-Forwarded-For when nothing is trusted', async () => {
    const response = await request(echoIp(false)).get('/').set('X-Forwarded-For', '203.0.113.5');
    expect(response.body.ip).not.toBe('203.0.113.5');
  });

  it('takes the client address from a trusted local proxy', async () => {
    const response = await request(echoIp(['loopback']))
      .get('/')
      .set('X-Forwarded-For', '203.0.113.5');
    expect(response.body.ip).toBe('203.0.113.5');
  });

  it('cannot be spoofed by prepending addresses to the header', async () => {
    // nginx appends the real peer; whatever the client wrote sits to its left and is not trusted.
    const response = await request(echoIp(['loopback']))
      .get('/')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.5');
    expect(response.body.ip).toBe('203.0.113.5');
  });
});

describe('rate limiting uses that address', () => {
  it('a direct client cannot dodge its limit by inventing X-Forwarded-For', async () => {
    const app = limitedToOne(false);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.2').expect(429);
  });

  it('behind a trusted proxy, two shoppers get separate limits', async () => {
    const app = limitedToOne(['loopback']);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.2').expect(200);
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(429);
  });
});
