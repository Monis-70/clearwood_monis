/**
 * Query normalisation shared by the search driver and the suggestion service.
 *
 * Pure string work only — no database, no provider-specific behaviour — so the same normalised
 * form is stored at index time and computed at query time, on SQLite and on MySQL alike.
 */

const DIACRITICS = /[\u0300-\u036f]/g;
const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;
const WHITESPACE = /\s+/g;

/** Spelling variants Indian furniture shoppers actually type. Applied before synonym expansion. */
const TRANSLITERATIONS: Record<string, string> = {
  sofaa: 'sofa',
  couche: 'couch',
  seater: 'seater',
  seatter: 'seater',
  teakwood: 'teak wood',
  sagwan: 'teak',
  almirah: 'almirah',
  alimrah: 'almirah',
  matress: 'mattress',
  mattres: 'mattress',
  furnitures: 'furniture',
  recliners: 'recliner',
  diwaan: 'diwan',
  divan: 'diwan',
  cusion: 'cushion',
  wardrob: 'wardrobe',
};

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'and', 'in', 'on', 'to']);

export function normalise(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

export function tokenise(input: string): string[] {
  const normalised = normalise(input);
  if (!normalised) return [];

  const tokens = normalised
    .split(' ')
    .flatMap((token) => (TRANSLITERATIONS[token] ?? token).split(' '))
    .filter(Boolean);

  const meaningful = tokens.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

/** "3 seater" and "3-seater" must reach the same documents, so digits glue to the next word too. */
export function withNumberJoins(tokens: string[]): string[] {
  const extra: string[] = [];

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i]!;
    const next = tokens[i + 1]!;
    if (/^\d+$/.test(current)) extra.push(`${current}${next}`);
  }
  return extra;
}

export interface SynonymEntry {
  term: string;
  synonyms: string[];
  isTwoWay: boolean;
}

/**
 * Expands a token list with admin-managed synonyms. A one-way entry only fires when the query
 * contains the term; a two-way entry also maps any synonym back to the term and its siblings.
 */
export function expandSynonyms(tokens: string[], entries: SynonymEntry[]): string[] {
  const expanded = new Set(tokens);
  const phrase = tokens.join(' ');

  for (const entry of entries) {
    const term = normalise(entry.term);
    const synonyms = entry.synonyms.map(normalise).filter(Boolean);
    const hasTerm = expanded.has(term) || phrase.includes(term);

    if (hasTerm) {
      for (const synonym of synonyms) expanded.add(synonym);
      continue;
    }

    if (!entry.isTwoWay) continue;

    const matched = synonyms.find((synonym) => expanded.has(synonym) || phrase.includes(synonym));
    if (!matched) continue;

    expanded.add(term);
    for (const synonym of synonyms) expanded.add(synonym);
  }

  return [...expanded];
}

/** Cheap edit-distance-1 check, used only as a last resort when a query returns nothing. */
export function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 4 || b.length < 4) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }

  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function highlightRange(
  label: string,
  prefix: string,
): { start: number; length: number } | null {
  const index = normalise(label).indexOf(normalise(prefix));
  return index === -1 ? null : { start: index, length: prefix.length };
}
