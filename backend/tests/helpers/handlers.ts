import type { Express } from 'express';

/**
 * Every handler function Express has mounted, with enough context to name the offender.
 *
 * `mountedRoutes` answers "which URLs exist"; this answers "what will actually run", which is the
 * question the middleware-factory bug turns on.
 */

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack?: { handle?: unknown; name?: string }[] };
  name?: string;
  regexp?: RegExp;
  handle?: { stack?: Layer[] } & ((...args: unknown[]) => unknown);
}

export interface MountedHandler {
  /** `GET /api/v1/orders/:id`, or `use /api/v1` for non-route middleware. */
  where: string;
  name: string;
  arity: number;
}

function prefixOf(layer: Layer): string {
  const source = layer.regexp?.source ?? '';

  const cleaned = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\?\(\?=\/\|\$\)/g, '');

  return cleaned === '/' || cleaned === '(?:/)?' ? '' : cleaned;
}

/** Walks the live stack and returns every handler, including route-level middleware. */
export function mountedHandlers(app: Express): MountedHandler[] {
  const found: MountedHandler[] = [];

  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const method = Object.keys(layer.route.methods)
          .filter((entry) => entry !== '_all')[0]
          ?.toUpperCase();
        const where = `${method ?? 'ALL'} ${prefix}${layer.route.path}`;

        for (const entry of layer.route.stack ?? []) {
          const handle = entry.handle as ((...args: unknown[]) => unknown) | undefined;
          if (typeof handle !== 'function') continue;

          found.push({ where, name: handle.name || entry.name || '<anonymous>', arity: handle.length });
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer));
        continue;
      }

      if (typeof layer.handle === 'function') {
        found.push({
          where: `use ${prefix || '/'}`,
          name: layer.handle.name || layer.name || '<anonymous>',
          arity: layer.handle.length,
        });
      }
    }
  };

  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');

  return found;
}
