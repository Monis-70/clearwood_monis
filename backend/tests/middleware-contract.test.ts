import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

import { mountedHandlers } from './helpers/handlers';
import { mountedRoutes } from './helpers/routes';

/**
 * Prompt B1 Task 1 — a middleware FACTORY must never reach Express as a handler.
 *
 * It has happened three times on this project. Express calls the factory with (req, res, next),
 * throws away the handler it returns, never calls next, and the request hangs until it times out.
 * The failure is invisible in a unit test and shows up as a 30-second stall in CI.
 *
 * TypeScript does not catch it. A probe confirmed that BOTH of these compile clean:
 *
 *     const handler: RequestHandler = optionalAuth;   // factory, not handler
 *     router.get('/x', optionalAuth);                 // the real-world mistake
 *
 * because Express's `RequestHandler` call signature is checked bivariantly and its router
 * overloads widen. So a type-level brand cannot close this hole; it is closed here instead, plus
 * an eslint `no-restricted-syntax` rule that flags the known factory names at lint time.
 */

const app = createApp();

describe('every mounted handler is a handler, not a factory', () => {
  it('finds a substantial handler stack to check', () => {
    // G1: an empty stack would satisfy every assertion below.
    const handlers = mountedHandlers(app);

    expect(handlers.length).toBeGreaterThan(400);
    expect(mountedRoutes(app).length).toBeGreaterThan(200);
  });

  /**
   * Every real middleware takes (req, res, next) or (err, req, res, next). A factory takes its
   * configuration — one argument, sometimes none — so anything below arity 2 is the bug.
   */
  it('has no handler with an arity below 2', () => {
    const suspects = mountedHandlers(app)
      .filter((handler) => handler.arity < 2)
      .map((handler) => `${handler.where} -> ${handler.name}(${handler.arity} args)`);

    expect(
      suspects,
      'These look like middleware FACTORIES passed bare to Express. Call them: ' +
        'authenticate("ADMIN"), idempotency("scope"), validate({ body }).\n' +
        suspects.join('\n'),
    ).toEqual([]);
  });

  it('has no handler with an implausible arity above 4', () => {
    const suspects = mountedHandlers(app)
      .filter((handler) => handler.arity > 4)
      .map((handler) => `${handler.where} -> ${handler.name}(${handler.arity} args)`);

    expect(suspects).toEqual([]);
  });

  /** Proves the check can actually fail, rather than passing because it inspects nothing. */
  it('would catch a factory if one were mounted', async () => {
    const { Router } = await import('express');
    const express = (await import('express')).default;

    const factory = (scope: string) => (_req: unknown, _res: unknown, next: () => void) => {
      void scope;
      next();
    };

    const broken = express();
    const router = Router();

    // Exactly the mistake: the factory itself, not factory('x').
    router.get('/boom', factory as never);
    broken.use(router);

    const suspects = mountedHandlers(broken).filter((handler) => handler.arity < 2);

    expect(suspects.length).toBeGreaterThan(0);
    expect(suspects[0].where).toContain('/boom');
  });
});

/**
 * The behavioural backstop: a hung handler must fail fast in CI rather than stalling the suite.
 *
 * Every mounted GET is called anonymously. The status does not matter — 401, 404 and 422 are all
 * fine — only that SOMETHING comes back. A factory mounted bare never responds at all.
 */
describe('every mounted GET responds', () => {
  it('answers within a short timeout, whatever the status', async () => {
    const routes = mountedRoutes(app)
      .filter((route) => route.startsWith('GET '))
      .map((route) => route.slice(4))
      // Root-level file streaming and the docs UI are not JSON routes.
      .filter((route) => !route.startsWith('/media') && !route.startsWith('/docs'))
      // Substitute something harmless for path parameters.
      .map((route) => route.replace(/\{[^}]+\}/g, 'probe-value'));

    // G1: probing zero routes would pass trivially.
    expect(routes.length).toBeGreaterThan(100);

    const stalled: string[] = [];

    for (const route of routes) {
      const answered = await Promise.race([
        request(app)
          .get(route)
          .then(() => true)
          .catch(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);

      if (!answered) stalled.push(route);
    }

    expect(
      stalled,
      `These routes never responded — almost certainly a middleware factory mounted bare:\n${stalled.join('\n')}`,
    ).toEqual([]);
  }, 300_000);
});
