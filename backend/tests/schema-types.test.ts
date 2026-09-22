import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Phase 1 guard — rule D4 retired, replaced by an explicit type contract.
 *
 * D4 forbade `@db.*` so the schema stayed portable to SQLite. SQLite is no longer a target, and the
 * old rule became actively dangerous: Prisma maps a bare `String` to VARCHAR(191) on MySQL, so a
 * column holding a pricing breakdown or a webhook payload would have been truncated on write with
 * no error. Every String column now declares its type, and this test is what keeps the next one
 * from slipping through.
 */

const schema = readFileSync(
  path.resolve(__dirname, '..', 'prisma', 'schema.prisma'),
  'utf8',
);

interface Column {
  model: string;
  field: string;
  type: string | null;
  line: number;
  indexed: boolean;
}

function readStringColumns(): Column[] {
  const columns: Column[] = [];
  const lines = schema.split(/\r?\n/);

  let model: string | null = null;
  let fieldsInIndex = new Set<string>();
  let pending: Column[] = [];

  const flush = (): void => {
    for (const column of pending) {
      column.indexed = fieldsInIndex.has(column.field);
      columns.push(column);
    }
    pending = [];
    fieldsInIndex = new Set();
  };

  lines.forEach((line, index) => {
    const opening = /^model\s+(\w+)\s*\{/.exec(line);
    if (opening) {
      model = opening[1]!;
      return;
    }

    if (model && /^\}/.test(line)) {
      flush();
      model = null;
      return;
    }

    if (!model) return;

    const block = /^\s+@@(?:unique|index|id)\(\s*\[([^\]]+)\]/.exec(line);
    if (block) {
      for (const name of block[1]!.split(',')) fieldsInIndex.add(name.trim().split('(')[0]!);
      return;
    }

    const field = /^\s+(\w+)\s+String(\??)\s*(.*)$/.exec(line);
    if (!field) return;

    if (/@unique\b/.test(field[3]!) || /@id\b/.test(field[3]!)) fieldsInIndex.add(field[1]!);

    pending.push({
      model,
      field: field[1]!,
      type: /@db\.(\w+(?:\(\d+\))?)/.exec(field[3]!)?.[1] ?? null,
      line: index + 1,
      indexed: false,
    });
  });

  flush();
  return columns;
}

const columns = readStringColumns();

describe('every String column declares its MySQL type', () => {
  it('scanned a realistic number of columns across a realistic number of models', () => {
    // G1: every assertion below is vacuously true if the parser found nothing.
    expect(columns.length).toBeGreaterThan(500);
    expect(new Set(columns.map((column) => column.model)).size).toBeGreaterThan(50);
  });

  it('leaves no String column to default to VARCHAR(191)', () => {
    const untyped = columns.filter((column) => column.type === null);

    expect(
      untyped.map((column) => `${column.model}.${column.field} (line ${column.line})`),
      'These String columns have no @db type and would become VARCHAR(191) on MySQL, silently ' +
        'truncating anything longer. Give each one an explicit type - see PROJECT_CONTEXT ' +
        '"the type contract that replaced D4".',
    ).toEqual([]);
  });

  it('never indexes a TEXT column, which MySQL cannot do without a prefix length', () => {
    const offenders = columns.filter(
      (column) => column.indexed && /^(Text|MediumText|LongText)$/.test(column.type ?? ''),
    );

    expect(
      offenders.map((column) => `${column.model}.${column.field} is @db.${column.type}`),
      'A TEXT column cannot take part in an index without a prefix length. Either shorten the ' +
        'column to a VarChar or drop it from the index.',
    ).toEqual([]);
  });

  it('keeps indexed columns inside the 3072-byte utf8mb4 index limit', () => {
    const tooWide = columns.filter((column) => {
      const size = /^VarChar\((\d+)\)$/.exec(column.type ?? '');
      return column.indexed && size !== null && Number(size[1]) * 4 > 3072;
    });

    expect(
      tooWide.map((column) => `${column.model}.${column.field} is @db.${column.type}`),
      'utf8mb4 costs 4 bytes per character, so an indexed column may be at most VarChar(768).',
    ).toEqual([]);
  });

  it('types every column the migration brief named, and none of them as VarChar(191)', () => {
    const required: Record<string, string> = {
      'Order.breakdownJson': 'LongText',
      'OrderItem.componentsJson': 'LongText',
      'WebhookEvent.payloadJson': 'LongText',
      'Payment.rawResponseJson': 'LongText',
      'PageBlock.configJson': 'LongText',
      'PageBlock.rawConfigJson': 'LongText',
      'ImportJob.errorsJson': 'LongText',
      'Collection.rulesJson': 'LongText',
      'DiscountRule.conditionsJson': 'LongText',
      'DiscountRule.actionsJson': 'LongText',
      'AuditLog.changesJson': 'LongText',
      'HelpArticle.bodyMarkdown': 'Text',
      'HelpArticle.bodyHtml': 'Text',
      'NotificationTemplate.body': 'Text',
      'Product.description': 'Text',
      'Product.searchKeywords': 'Text',
      'Media.lqipDataUri': 'Text',
      'SearchDocument.bodyText': 'Text',
      'SearchDocument.keywordsText': 'Text',
      'SearchDocument.attributeText': 'Text',
      'Page.seoDescription': 'Text',
      'Page.seoKeywords': 'Text',
    };

    const actual = new Map(
      columns.map((column) => [`${column.model}.${column.field}`, column.type]),
    );

    for (const [name, type] of Object.entries(required)) {
      expect(actual.get(name), `${name} must be @db.${type}`).toBe(type);
    }
  });

  it('gives every digest column a fixed width rather than a variable one', () => {
    const digests = columns.filter((column) => /(Hash|checksum)$/i.test(column.field));

    expect(digests.length).toBeGreaterThan(5);

    for (const column of digests) {
      expect(
        column.type,
        `${column.model}.${column.field} holds a digest and should be Char(64) or a bounded ` +
          'VarChar, never an unbounded text column',
      ).toMatch(/^(Char\(64\)|VarChar\(\d+\))$/);
    }
  });
});
