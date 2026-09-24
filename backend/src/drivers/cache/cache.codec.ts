/**
 * The one serialisation both cache drivers use, so memory in development behaves like Redis in
 * production: a value comes back as plain JSON (no Dates, Maps, class instances or shared object
 * references). A value that cannot round-trip is simply not cached.
 */

export type Encoded = { ok: true; text: string; bytes: number } | { ok: false; reason: string };

export function encode(value: unknown, maxBytes: number): Encoded {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'not serialisable' };
  }

  if (text === undefined) return { ok: false, reason: 'value is not JSON' };

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) return { ok: false, reason: `value is ${bytes} bytes (cap ${maxBytes})` };

  return { ok: true, text, bytes };
}

/** `undefined` means "unreadable": the caller treats it as a miss and drops the entry. */
export function decode<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
