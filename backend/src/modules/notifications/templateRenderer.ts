import type { NotificationEvent } from '@shared/enums';

import { AppError } from '../../utils/AppError';

/**
 * Whitelisted token interpolation for notification templates.
 *
 * Templates are editable by admins through the console, so the substitution engine is a piece of
 * security surface: it renders operator-supplied strings. There is therefore NO expression
 * evaluation of any kind here. A token is a key lookup against a flat, pre-built record and
 * nothing else — no property paths, no function calls, no `eval`, no `new Function`, no template
 * literal reconstruction. `{{ a.b }}`, `{{ constructor }}` and `{{ __proto__ }}` are all simply
 * unknown tokens.
 *
 * Unknown tokens are handled differently by environment on purpose:
 *
 * - In tests (and any non-production build) an unknown token THROWS. A typo in a template is a
 *   defect and must stop the build rather than reach a customer.
 * - In production an unknown token renders as an empty string. A template typo must never take
 *   down order confirmation emails, and half a sentence is better than a 500.
 */

/** `{{ token }}` — letters, digits and underscore only. Deliberately cannot express a path. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Keys that exist on every object and must never resolve, even if a context somehow supplies one. */
const NEVER_RESOLVE = new Set(['__proto__', 'constructor', 'prototype']);

export type TemplateContext = Record<string, string>;

export interface RenderOptions {
  /** Throw on an unknown token instead of rendering empty. Defaults to "not production". */
  strict?: boolean;
  /** For the error message, so a template typo names the template it came from. */
  event?: NotificationEvent | string;
}

export function renderTemplate(
  template: string,
  context: TemplateContext,
  options: RenderOptions = {},
): string {
  const strict = options.strict ?? process.env.NODE_ENV !== 'production';

  return template.replace(TOKEN, (_match, token: string) => {
    if (!NEVER_RESOLVE.has(token) && Object.hasOwn(context, token)) {
      return context[token];
    }

    if (strict) {
      throw new AppError(
        500,
        'NOTIFICATION_UNKNOWN_TOKEN',
        `Template${options.event ? ` for ${options.event}` : ''} uses unknown token "{{${token}}}"`,
        { token, known: Object.keys(context).sort() },
      );
    }

    return '';
  });
}

/** Every token a template references, in source order, deduplicated. */
export function tokensIn(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN)].map((match) => match[1]))];
}
