import { createHash } from 'node:crypto';

export interface OptionPair {
  attributeId: string;
  attributeValueId: string;
}

/**
 * The identity of a variant's option set, computed by the server and never accepted from a client:
 * SHA-256 over `attributeId=attributeValueId` pairs ordered by attributeId (binary order) and
 * joined with `&`, so the order a request lists them in cannot matter. `null` for no options.
 *
 * The catalog_integrity migration backfills the same value in SQL; the two must stay identical.
 */
export function combinationKeyOf(pairs: readonly OptionPair[]): string | null {
  if (pairs.length === 0) return null;

  const canonical = [...pairs]
    .sort((a, b) => (a.attributeId < b.attributeId ? -1 : a.attributeId > b.attributeId ? 1 : 0))
    .map((pair) => `${pair.attributeId}=${pair.attributeValueId}`)
    .join('&');

  return createHash('sha256').update(canonical).digest('hex');
}
