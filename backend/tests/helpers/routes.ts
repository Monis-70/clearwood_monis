import type { Express } from 'express';

/**
 * Enumerates the routes Express has ACTUALLY mounted, by walking the router stack.
 *
 * Reading the real stack rather than the route files is the point: a route that exists in a file
 * but is never mounted will not appear, and a route mounted from somewhere unexpected will. That is
 * what makes the OpenAPI completeness check meaningful rather than a second copy of the same list.
 */

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  regexp?: RegExp;
  handle?: { stack?: Layer[] };
}

/** Recovers a mount prefix from the regexp Express compiles for `app.use('/prefix', router)`. */
function mountPrefix(layer: Layer): string {
  const source = layer.regexp?.source ?? '';

  const cleaned = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\?\(\?=\/\|\$\)/g, '');

  return cleaned === '/' || cleaned === '(?:/)?' ? '' : cleaned;
}

/** `GET /api/v1/orders/{id}` for every mounted route, path params normalised to OpenAPI style. */
export function mountedRoutes(app: Express): string[] {
  return [...new Set(routeRegistrations(app))].sort();
}

/** Every registration, duplicates kept: a second registration of one route is dead code. */
export function routeRegistrations(app: Express): string[] {
  const found: string[] = [];

  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          found.push(normalise(`${method.toUpperCase()} ${prefix}${layer.route.path}`));
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPrefix(layer));
      }
    }
  };

  const root = app as unknown as { _router?: { stack: Layer[] }; router?: { stack: Layer[] } };
  walk(root._router?.stack ?? root.router?.stack ?? [], '');

  return found;
}

export function normalise(route: string): string {
  return route
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/+$/, '$1');
}
