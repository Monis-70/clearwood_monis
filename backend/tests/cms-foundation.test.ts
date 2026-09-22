import { describe, expect, it } from 'vitest';

import { BLOCK_TYPES } from '@shared/enums';
import { BLOCK_REGISTRY, mediaIdsIn, referencesIn, valuesAtPath } from '@shared/cms/blockRegistry';

import {
  sanitizeRichHtml,
  toPlainText,
  wasModified,
} from '../src/modules/cms/htmlSanitizer';

/**
 * Prompt 10A foundation - the block contract and the HTML allowlist.
 *
 * These are the two pieces every other CMS surface is built on: if the registry and the enum can
 * drift, "add a block type is three steps" stops being true; if the sanitiser leaks, an admin
 * account becomes stored XSS against every customer.
 */

/* --------------------------------------------------------------- registry */

describe('the block registry', () => {
  it('covers every BlockType, and is not empty', () => {
    // G1: iterating an empty list would make every assertion below vacuous.
    expect(BLOCK_TYPES.length).toBeGreaterThanOrEqual(22);
    expect(Object.keys(BLOCK_REGISTRY).length).toBe(BLOCK_TYPES.length);

    for (const type of BLOCK_TYPES) {
      expect(BLOCK_REGISTRY[type], `no registry entry for ${type}`).toBeDefined();
      expect(BLOCK_REGISTRY[type].type).toBe(type);
    }
  });

  it('gives every block a label, description, category and schema', () => {
    for (const type of BLOCK_TYPES) {
      const definition = BLOCK_REGISTRY[type];

      expect(definition.label.length, `${type} label`).toBeGreaterThan(2);
      expect(definition.description.length, `${type} description`).toBeGreaterThan(10);
      expect(definition.category, `${type} category`).toBeTruthy();
      expect(typeof definition.configSchema.parse, `${type} schema`).toBe('function');
    }
  });

  /** The rule that stops a half-defined block type reaching the builder. */
  it('gives every block a defaultConfig that validates against its own schema', () => {
    for (const type of BLOCK_TYPES) {
      const definition = BLOCK_REGISTRY[type];
      const result = definition.configSchema.safeParse(definition.defaultConfig);

      expect(
        result.success,
        `${type} defaultConfig is invalid: ${JSON.stringify(
          result.success ? null : result.error.issues,
        )}`,
      ).toBe(true);
    }
  });

  it('declares mediaFields and referenceFields on every block', () => {
    for (const type of BLOCK_TYPES) {
      const definition = BLOCK_REGISTRY[type];

      expect(Array.isArray(definition.mediaFields), `${type} mediaFields`).toBe(true);
      expect(typeof definition.referenceFields, `${type} referenceFields`).toBe('object');
    }

    // G1: the declarations only mean something if some block actually declares some.
    const withMedia = BLOCK_TYPES.filter((type) => BLOCK_REGISTRY[type].mediaFields.length > 0);
    const withRefs = BLOCK_TYPES.filter(
      (type) => Object.keys(BLOCK_REGISTRY[type].referenceFields).length > 0,
    );

    expect(withMedia.length).toBeGreaterThan(5);
    expect(withRefs.length).toBeGreaterThan(3);
  });
});

describe('config path extraction', () => {
  it('reads a top-level field', () => {
    expect(valuesAtPath({ mediaId: 'm1' }, 'mediaId')).toEqual(['m1']);
  });

  it('reads a field on every array element', () => {
    const config = { slides: [{ mediaId: 'a' }, { mediaId: 'b' }, {}] };
    expect(valuesAtPath(config, 'slides[].mediaId')).toEqual(['a', 'b']);
  });

  it('reads an array-valued field', () => {
    expect(valuesAtPath({ categoryIds: ['c1', 'c2'] }, 'categoryIds')).toEqual(['c1', 'c2']);
  });

  it('returns nothing rather than throwing on a missing path', () => {
    expect(valuesAtPath({}, 'slides[].mediaId')).toEqual([]);
    expect(valuesAtPath(null, 'mediaId')).toEqual([]);
  });

  it('collects media ids generically, with no per-type code', () => {
    const ids = mediaIdsIn('HERO_SLIDER', {
      slides: [
        { mediaId: 'hero-1', mobileMediaId: 'hero-1-m' },
        { mediaId: 'hero-2' },
      ],
    });

    expect(ids).toHaveLength(3);
    expect(ids).toContain('hero-1');
    expect(ids).toContain('hero-1-m');
    expect(ids).toContain('hero-2');
  });

  it('groups references by what they point at', () => {
    const references = referencesIn('PRODUCT_GRID', {
      productIds: ['p1', 'p2'],
      collectionId: 'coll-1',
    });

    expect(references.productIds).toEqual(['p1', 'p2']);
    expect(references.collectionIds).toEqual(['coll-1']);
    expect(references.categoryIds).toEqual([]);
  });

  it('deduplicates', () => {
    expect(mediaIdsIn('HERO_SLIDER', { slides: [{ mediaId: 'x' }, { mediaId: 'x' }] })).toEqual([
      'x',
    ]);
  });
});

/* -------------------------------------------------------------- sanitiser */

describe('the HTML sanitiser', () => {
  it.each([
    ['<script>alert(1)</script>', 'script tag'],
    ['<img src=x onerror="alert(1)">', 'inline event handler'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript: URL'],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', 'mixed-case javascript: URL'],
    ['<iframe src="https://evil.example.com/x"></iframe>', 'non-whitelisted iframe host'],
    ['<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==">', 'data: URI image'],
    ['<svg><script>alert(1)</script></svg>', 'SVG with script'],
    ['<body onload="alert(1)">x</body>', 'body onload'],
    ['<form action="https://evil.example.com"><input name="card"></form>', 'credential-harvest form'],
    ['<object data="evil.swf"></object>', 'object embed'],
    ['<a href="vbscript:msgbox(1)">x</a>', 'vbscript: URL'],
    ['<div style="background:url(javascript:alert(1))">x</div>', 'CSS expression'],
  ])('neutralises %s (%s)', (payload) => {
    const clean = sanitizeRichHtml(payload);

    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onerror|onload|onclick/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/vbscript:/i);
    expect(clean).not.toMatch(/<iframe[^>]*evil/i);
    expect(clean).not.toMatch(/<object/i);
    expect(clean).not.toMatch(/<form/i);
    expect(clean).not.toMatch(/style=/i);
    expect(clean).not.toMatch(/data:image/i);
  });

  /** The classic defeat of a regex-based "strip <script>" sanitiser. */
  it('neutralises a nested payload that survives naive tag stripping', () => {
    const clean = sanitizeRichHtml('<scr<script>ipt>alert(1)</scr</script>ipt>');

    expect(clean).not.toMatch(/<script/i);
    expect(clean.toLowerCase()).not.toContain('<scr');
  });

  it('neutralises an obfuscated entity-encoded handler', () => {
    const clean = sanitizeRichHtml('<img src=x o\u006Eerror=alert(1)>');
    expect(clean).not.toMatch(/onerror/i);
  });

  it('discards script CONTENT, not merely its tags', () => {
    // Untagging leaves the payload as visible text, which is still the payload.
    const clean = sanitizeRichHtml('<script>steal(document.cookie)</script>');
    expect(clean).not.toContain('steal(document.cookie)');
    expect(clean.trim()).toBe('');
  });

  it('keeps legitimate formatting', () => {
    const clean = sanitizeRichHtml(
      '<h2>Care guide</h2><p>Wipe with a <strong>dry</strong> cloth.</p><ul><li>No solvents</li></ul>',
    );

    expect(clean).toContain('<h2>Care guide</h2>');
    expect(clean).toContain('<strong>dry</strong>');
    expect(clean).toContain('<li>No solvents</li>');
  });

  it('keeps a whitelisted YouTube iframe', () => {
    const clean = sanitizeRichHtml('<iframe src="https://www.youtube.com/embed/abc123"></iframe>');

    expect(clean).toContain('<iframe');
    expect(clean).toContain('youtube.com/embed/abc123');
    expect(clean).toContain('loading="lazy"');
  });

  it('accepts an extra iframe host from settings without losing the defaults', () => {
    const options = { iframeHosts: ['player.example.com'] };

    expect(sanitizeRichHtml('<iframe src="https://player.example.com/v/1"></iframe>', options)).toContain(
      '<iframe',
    );
    expect(sanitizeRichHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>', options)).toContain(
      '<iframe',
    );
    expect(sanitizeRichHtml('<iframe src="https://evil.example.com/v/1"></iframe>', options)).not.toContain(
      '<iframe',
    );
  });

  it('drops iframes entirely when the caller forbids them', () => {
    const clean = sanitizeRichHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>', {
      allowIframes: false,
    });

    expect(clean).not.toContain('<iframe');
  });

  it('adds noopener to links that open a new tab', () => {
    const clean = sanitizeRichHtml('<a href="https://example.com" target="_blank">x</a>');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps safe link schemes', () => {
    expect(sanitizeRichHtml('<a href="/sofas">Sofas</a>')).toContain('href="/sofas"');
    expect(sanitizeRichHtml('<a href="mailto:a@b.com">Mail</a>')).toContain('mailto:');
    expect(sanitizeRichHtml('<a href="tel:+919876543210">Call</a>')).toContain('tel:');
  });

  it('reports that it changed something, so the admin can be told', () => {
    const raw = '<p>Hello</p><script>alert(1)</script>';
    const clean = sanitizeRichHtml(raw);

    expect(wasModified(raw, clean)).toBe(true);
    expect(wasModified('<p>Hello</p>', sanitizeRichHtml('<p>Hello</p>'))).toBe(false);
  });

  it('flattens to plain text for excerpts and the search index', () => {
    const text = toPlainText('<h2>Delivery</h2><p>Ships in <strong>2</strong> weeks.</p>');

    expect(text).toBe('Delivery Ships in 2 weeks.');
    expect(text).not.toContain('<');
  });

  it('handles empty and absent input without throwing', () => {
    expect(sanitizeRichHtml('')).toBe('');
    expect(toPlainText('')).toBe('');
  });
});
