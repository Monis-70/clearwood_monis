/**
 * Rupees in words, the Indian way.
 *
 * A GST tax invoice must state the amount in words, and it must do so in the Indian numbering
 * system: lakh and crore, not million and billion. "Rupees Twelve Lakh Thirty Four Thousand Five
 * Hundred and Sixty Seven Only" — an auditor reads this, not the digits.
 *
 * PURE. No formatting library, no locale lookup, no I/O.
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

/** 0-99, the only range with irregular names. */
function twoDigits(value: number): string {
  if (value < 20) return ONES[value] ?? '';

  const tens = TENS[Math.floor(value / 10)] ?? '';
  const ones = ONES[value % 10] ?? '';

  return ones ? `${tens} ${ones}` : tens;
}

function threeDigits(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;

  if (hundreds === 0) return twoDigits(rest);
  if (rest === 0) return `${ONES[hundreds]} Hundred`;

  return `${ONES[hundreds]} Hundred and ${twoDigits(rest)}`;
}

/**
 * Indian grouping: the last three digits, then PAIRS of two.
 *
 * 12345678 reads as 1 crore 23 lakh 45 thousand 678 — not 12 million 345 thousand.
 */
function indianWords(value: number): string {
  if (value === 0) return 'Zero';

  const parts: string[] = [];

  const crore = Math.floor(value / 10_000_000);
  const lakh = Math.floor((value % 10_000_000) / 100_000);
  const thousand = Math.floor((value % 100_000) / 1_000);
  const rest = value % 1_000;

  if (crore > 0) parts.push(`${indianWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest > 0) parts.push(threeDigits(rest));

  return parts.join(' ');
}

/**
 * `12_34_567` paise → "Rupees Twelve Thousand Three Hundred and Forty Five and Paise Sixty Seven Only".
 *
 * Takes PAISE, because everything in this codebase is paise and converting at the call site is how
 * a rounding error gets onto a legal document.
 */
export function amountInWords(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`amountInWords needs whole paise, got ${paise}`);
  }

  const negative = paise < 0;
  const absolute = Math.abs(paise);

  const rupees = Math.floor(absolute / 100);
  const remainder = absolute % 100;

  const rupeeWords = `Rupees ${indianWords(rupees)}`;
  const paiseWords = remainder > 0 ? ` and Paise ${twoDigits(remainder)}` : '';

  return `${negative ? 'Minus ' : ''}${rupeeWords}${paiseWords} Only`;
}
