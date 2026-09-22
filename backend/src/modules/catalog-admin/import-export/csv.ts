/**
 * CSV serialisation with spreadsheet formula-injection protection.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is executed as a formula
 * by Excel, LibreOffice and Google Sheets when the export is opened. An exported product name of
 * `=HYPERLINK("http://evil","click")` would then run on the admin's machine.
 *
 * Rule (documented in PROJECT_CONTEXT): any cell whose first character is one of
 * `= + - @ \t \r` is prefixed with a single quote (`'`) before quoting. The apostrophe is the
 * canonical spreadsheet "treat as text" marker and is stripped again on import, so an
 * export -> import round trip is lossless.
 */

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = value instanceof Date ? value.toISOString() : String(value);
  const neutralised = DANGEROUS_PREFIX.test(raw) ? `'${raw}` : raw;

  return /[",\n\r]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

/** Undoes escapeCsvValue's leading apostrophe so a round trip produces identical data. */
export function unescapeCsvValue(value: string): string {
  return value.startsWith("'") && DANGEROUS_PREFIX.test(value.slice(1)) ? value.slice(1) : value;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(escapeCsvValue).join(',')}\r\n`;
}

/**
 * Money in CSV is rupees with exactly two decimals, so a human can read and edit it in a
 * spreadsheet. Storage stays Int paise (D5).
 */
export function paiseToCsv(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  return (paise / 100).toFixed(2);
}

/**
 * Parses a rupee amount back to paise. Accepts thousands separators ("12,999.50") and rejects
 * anything with more than two decimals so a typo can never silently lose money. Rounds half up.
 */
export function csvToPaise(value: string | null | undefined, column = 'price'): number | null {
  if (value === null || value === undefined) return null;

  const trimmed = unescapeCsvValue(String(value)).trim().replace(/[₹\s]/g, '');
  if (trimmed === '') return null;

  const normalised = trimmed.replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalised)) {
    if (/^-?\d+\.\d{3,}$/.test(normalised)) {
      throw new Error(`${column}: at most two decimal places are allowed (got "${value}")`);
    }
    throw new Error(`${column}: "${value}" is not a valid amount`);
  }

  const [rupees, decimals = ''] = normalised.split('.');
  const paise = Number(`${rupees}${decimals.padEnd(2, '0')}`);

  if (!Number.isSafeInteger(paise)) throw new Error(`${column}: "${value}" is out of range`);
  return paise;
}

export function csvBoolean(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().toLowerCase();
  if (trimmed === '') return null;
  if (['true', '1', 'yes', 'y'].includes(trimmed)) return true;
  if (['false', '0', 'no', 'n'].includes(trimmed)) return false;
  throw new Error(`"${value}" is not a boolean`);
}
