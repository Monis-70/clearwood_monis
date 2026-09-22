import { createHash } from 'node:crypto';

/**
 * RULE 2 — a cart line is identified by a deterministic key, not by a row id.
 *
 * `sha256(productId | variantId ?? '' | sortedOptionValueIds | customizationHash ?? '')`
 *
 * Sorting the option ids is what makes the key stable: the same configuration arriving with its
 * attributes in a different order must land on the same line. The trailing customization segment is
 * reserved for Prompt 11, so adding a configurator changes neither this formula nor the schema.
 */

export function hashCustomization(customization: unknown): string | null {
  if (customization === null || customization === undefined) return null;

  const normalised = JSON.stringify(customization, Object.keys(customization as object).sort());
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

export function buildLineKey(input: {
  productId: string;
  variantId?: string | null;
  optionValueIds?: string[];
  customizationHash?: string | null;
}): string {
  const parts = [
    input.productId,
    input.variantId ?? '',
    [...(input.optionValueIds ?? [])].sort().join(','),
    input.customizationHash ?? '',
  ];

  return createHash('sha256').update(parts.join('|')).digest('hex');
}
