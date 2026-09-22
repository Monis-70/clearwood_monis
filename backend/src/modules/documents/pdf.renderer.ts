import { createHash } from 'node:crypto';

import PDFDocument from 'pdfkit';

/**
 * The PDF renderer.
 *
 * OFFLINE: no fonts fetched, no images pulled, no network of any kind. A tax invoice that cannot be
 * produced because a CDN is down is not a tax invoice.
 *
 * DETERMINISTIC: the same document data must produce byte-identical output, every time, forever.
 * That is what makes `renderChecksum` meaningful — it proves the stored PDF is the one we generated
 * and that nobody has edited the figures since. PDFKit works against us here in two ways, and both
 * are neutralised below:
 *
 *   1. it stamps CreationDate and ModDate with `new Date()`, so two renders a second apart differ;
 *   2. it embeds a document ID derived from those dates.
 *
 * So the dates are pinned to a value the CALLER supplies (the invoice's own issue date), never to
 * the clock. A render is therefore a pure function of its input.
 */

export interface RenderedDocument {
  bytes: Buffer;
  /** SHA-256 of the bytes. Stored, and re-verified on download. */
  checksum: string;
}

export interface InvoiceParty {
  name: string;
  gstin?: string | null;
  address: string[];
  phone?: string | null;
  email?: string | null;
  stateCode?: string | null;
}

export interface InvoiceLine {
  description: string;
  hsnCode: string | null;
  qty: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface InvoiceDocumentData {
  kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
  documentNumber: string;
  issuedAt: Date;
  orderNumber: string;
  orderPlacedAt: Date | null;
  /** Only on a credit note: the invoice it corrects. */
  againstDocumentNumber?: string | null;
  seller: InvoiceParty;
  billTo: InvoiceParty;
  shipTo: InvoiceParty | null;
  placeOfSupply: string;
  isInterState: boolean;
  lines: InvoiceLine[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundingPaise: number;
  totalPaise: number;
  amountInWords: string;
  notes?: string[];
}

const MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4 portrait, points.
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);

  // Indian grouping: 12,34,567.89
  const whole = Math.floor(absolute / 100).toString();
  const fraction = String(absolute % 100).padStart(2, '0');

  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;

  return `${sign}${grouped}.${fraction}`;
}

function bp(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

export function renderInvoicePdf(data: InvoiceDocumentData): Promise<RenderedDocument> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    // Pinned to the document's own issue date, never the clock. This is what makes the render
    // deterministic and the checksum worth storing.
    info: {
      Title: `${data.kind === 'TAX_INVOICE' ? 'Tax Invoice' : 'Credit Note'} ${data.documentNumber}`,
      Author: data.seller.name,
      Subject: `Order ${data.orderNumber}`,
      CreationDate: data.issuedAt,
      ModDate: data.issuedAt,
    },
  });

  const chunks: Buffer[] = [];

  // PDFKit flushes asynchronously: `doc.end()` only STARTS the write. Reading the chunks straight
  // after it yields an empty buffer — and two identical empty buffers look perfectly deterministic,
  // which is how this would have gone unnoticed.
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  /* ------------------------------------------------------------- heading */

  doc
    .fontSize(16)
    .font('Helvetica-Bold')
    .text(data.kind === 'TAX_INVOICE' ? 'TAX INVOICE' : 'CREDIT NOTE', { align: 'center' });

  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').text(data.seller.name, { align: 'center' });
  for (const line of data.seller.address) doc.text(line, { align: 'center' });
  if (data.seller.gstin) doc.text(`GSTIN: ${data.seller.gstin}`, { align: 'center' });

  doc.moveDown(0.8);

  /* ---------------------------------------------------------- references */

  const top = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').text('Document No:', MARGIN, top);
  doc.font('Helvetica').text(data.documentNumber, MARGIN + 80, top);

  doc.font('Helvetica-Bold').text('Date:', MARGIN + 300, top);
  doc.font('Helvetica').text(formatDate(data.issuedAt), MARGIN + 340, top);

  doc.font('Helvetica-Bold').text('Order No:', MARGIN, top + 14);
  doc.font('Helvetica').text(data.orderNumber, MARGIN + 80, top + 14);

  if (data.orderPlacedAt) {
    doc.font('Helvetica-Bold').text('Order Date:', MARGIN + 300, top + 14);
    doc.font('Helvetica').text(formatDate(data.orderPlacedAt), MARGIN + 370, top + 14);
  }

  if (data.againstDocumentNumber) {
    doc.font('Helvetica-Bold').text('Against Invoice:', MARGIN, top + 28);
    doc.font('Helvetica').text(data.againstDocumentNumber, MARGIN + 90, top + 28);
  }

  doc.y = top + (data.againstDocumentNumber ? 46 : 32);

  /* ------------------------------------------------------------ parties */

  const partyTop = doc.y;

  const party = (label: string, entry: InvoiceParty, x: number): void => {
    doc.fontSize(9).font('Helvetica-Bold').text(label, x, partyTop, { width: 240 });
    doc.font('Helvetica').text(entry.name, x, partyTop + 13, { width: 240 });

    let offset = partyTop + 25;
    for (const line of entry.address) {
      doc.text(line, x, offset, { width: 240 });
      offset += 11;
    }
    if (entry.phone) {
      doc.text(`Phone: ${entry.phone}`, x, offset, { width: 240 });
      offset += 11;
    }
    if (entry.gstin) doc.text(`GSTIN: ${entry.gstin}`, x, offset, { width: 240 });
  };

  party('Bill To', data.billTo, MARGIN);
  if (data.shipTo) party('Ship To', data.shipTo, MARGIN + 260);

  doc.y = partyTop + 88;
  doc.fontSize(9).font('Helvetica').text(`Place of Supply: ${data.placeOfSupply}`, MARGIN, doc.y);
  doc.moveDown(0.6);

  /* -------------------------------------------------------------- lines */

  const columns = data.isInterState
    ? [
        { label: '#', width: 18 },
        { label: 'Description', width: 170 },
        { label: 'HSN', width: 45 },
        { label: 'Qty', width: 28 },
        { label: 'Rate', width: 55 },
        { label: 'Taxable', width: 60 },
        { label: 'IGST', width: 60 },
        { label: 'Total', width: 65 },
      ]
    : [
        { label: '#', width: 18 },
        { label: 'Description', width: 155 },
        { label: 'HSN', width: 42 },
        { label: 'Qty', width: 26 },
        { label: 'Rate', width: 52 },
        { label: 'Taxable', width: 56 },
        { label: 'CGST', width: 50 },
        { label: 'SGST', width: 50 },
        { label: 'Total', width: 52 },
      ];

  const drawRow = (cells: string[], bold: boolean, y: number): number => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);

    let x = MARGIN;
    cells.forEach((cell, index) => {
      const column = columns[index]!;
      doc.text(cell, x + 2, y + 4, {
        width: column.width - 4,
        align: index === 0 || index === 1 || index === 2 ? 'left' : 'right',
      });
      x += column.width;
    });

    return y + 16;
  };

  let y = doc.y;
  doc.rect(MARGIN, y, CONTENT_WIDTH, 16).fill('#eeeeee');
  doc.fillColor('#000000');
  y = drawRow(columns.map((column) => column.label), true, y);

  data.lines.forEach((line, index) => {
    const cells = data.isInterState
      ? [
          String(index + 1),
          line.description,
          line.hsnCode ?? '-',
          String(line.qty),
          rupees(line.unitPricePaise),
          rupees(line.taxablePaise),
          `${rupees(line.igstPaise)} (${bp(line.taxRateBp)})`,
          rupees(line.totalPaise),
        ]
      : [
          String(index + 1),
          line.description,
          line.hsnCode ?? '-',
          String(line.qty),
          rupees(line.unitPricePaise),
          rupees(line.taxablePaise),
          rupees(line.cgstPaise),
          rupees(line.sgstPaise),
          rupees(line.totalPaise),
        ];

    y = drawRow(cells, false, y);
  });

  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).stroke();

  /* ------------------------------------------------------------ totals */

  const totals: [string, number][] = [
    ['Subtotal', data.subtotalPaise],
    ...(data.discountPaise !== 0 ? ([['Discount', -data.discountPaise]] as [string, number][]) : []),
    ...(data.shippingPaise !== 0 ? ([['Shipping', data.shippingPaise]] as [string, number][]) : []),
    ...(data.isInterState
      ? ([['IGST', data.igstPaise]] as [string, number][])
      : ([
          ['CGST', data.cgstPaise],
          ['SGST', data.sgstPaise],
        ] as [string, number][])),
    ...(data.roundingPaise !== 0
      ? ([['Rounding', data.roundingPaise]] as [string, number][])
      : []),
  ];

  let totalsY = y + 8;
  doc.fontSize(9);

  for (const [label, value] of totals) {
    doc.font('Helvetica').text(label, MARGIN + CONTENT_WIDTH - 200, totalsY, {
      width: 100,
      align: 'right',
    });
    doc.text(rupees(value), MARGIN + CONTENT_WIDTH - 95, totalsY, { width: 95, align: 'right' });
    totalsY += 13;
  }

  doc.font('Helvetica-Bold');
  doc.text('Total', MARGIN + CONTENT_WIDTH - 200, totalsY, { width: 100, align: 'right' });
  doc.text(rupees(data.totalPaise), MARGIN + CONTENT_WIDTH - 95, totalsY, {
    width: 95,
    align: 'right',
  });

  doc.font('Helvetica-Bold').fontSize(8).text('Amount in words:', MARGIN, totalsY + 24);
  doc.font('Helvetica').text(data.amountInWords, MARGIN, totalsY + 36, { width: CONTENT_WIDTH });

  /* ------------------------------------------------------------- footer */

  let footerY = totalsY + 64;
  doc.fontSize(7).font('Helvetica');

  for (const note of data.notes ?? []) {
    doc.text(note, MARGIN, footerY, { width: CONTENT_WIDTH });
    footerY += 10;
  }

  doc.text(
    'This is a computer-generated document and does not require a signature.',
    MARGIN,
    footerY + 6,
    { width: CONTENT_WIDTH, align: 'center' },
  );

  doc.end();

  return finished.then((bytes) => ({
    bytes,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  }));
}

/** The checksum of bytes already rendered, for verifying a stored document on download. */
export function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
