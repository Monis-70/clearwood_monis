import { env } from '../../config/env';
import { documentSequenceRepository } from '../../repositories/document.repository';

import { financialYearKey } from '../orders/orderNumber.service';

/**
 * Numbering for everything Prompt 9B issues.
 *
 * Shipments and returns are numbered per financial year like orders (`CWS/2026-27/000001`), because
 * that is the boundary Indian bookkeeping works to. Tax invoices and credit notes use the same
 * scheme for the same reason but with their own series, since GST requires an invoice series to be
 * unbroken and unique on its own — sharing a counter with shipments would put holes in it.
 *
 * All four allocate through `DocumentSequence`'s compare-and-set, so concurrency cannot hand out a
 * duplicate and cannot leave a gap.
 */

const PAD = 6;

async function allocate(
  prefix: string,
  series: string,
  now: Date,
): Promise<{ number: string; sequence: number; key: string }> {
  const fy = financialYearKey(now);
  const key = `${series}:${fy}`;
  const sequence = await documentSequenceRepository.next(key, prefix);

  return {
    key,
    sequence,
    number: `${prefix}/${fy}/${String(sequence).padStart(PAD, '0')}`,
  };
}

export const fulfilmentNumberService = {
  financialYearKey,

  shipment(now = new Date()) {
    return allocate(env.SHIPMENT_NUMBER_PREFIX, 'shipment', now);
  },

  return(now = new Date()) {
    return allocate(env.RETURN_NUMBER_PREFIX, 'return', now);
  },

  /** The GST tax invoice series. Never reused, never regenerated. */
  invoice(now = new Date()) {
    return allocate(env.INVOICE_NUMBER_PREFIX, 'invoice', now);
  },

  /** Its own series: a credit note corrects an invoice, it does not replace it. */
  creditNote(now = new Date()) {
    return allocate(env.CREDIT_NOTE_PREFIX, 'credit-note', now);
  },

  looksValidShipment(value: string): boolean {
    return new RegExp(`^${env.SHIPMENT_NUMBER_PREFIX}/\\d{4}-\\d{2}/\\d{${PAD},}$`).test(value);
  },

  looksValidReturn(value: string): boolean {
    return new RegExp(`^${env.RETURN_NUMBER_PREFIX}/\\d{4}-\\d{2}/\\d{${PAD},}$`).test(value);
  },
};
