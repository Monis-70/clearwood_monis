import { PrismaClient } from '@prisma/client';

import { formatINR } from '@shared/money';

import { pricingFacade } from '../src/modules/pricing/pricing.facade';

/**
 * Prints a worked price breakdown component by component — the delivery-report example and a quick
 * smoke test of the whole engine. Run with `npx tsx scripts/price-example.ts [slug] [qty] [coupon]`.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const slug = process.argv[2] ?? 'kabir-3-seater-fabric-sofa';
  const qty = Number(process.argv[3] ?? 1);
  const couponCode = process.argv[4];
  const pincode = process.argv[5] ?? '400001';

  const breakdown = await pricingFacade.quoteCart({
    items: [{ slug, qty }],
    ...(couponCode ? { couponCode } : {}),
    pincode,
    channel: 'WEB',
  });

  const line = breakdown.lines[0]!;
  const product = await prisma.product.findUniqueOrThrow({ where: { slug } });

  console.log(`${product.name}  (${product.sku})  x${qty}  pincode ${pincode}`);
  console.log('='.repeat(78));

  for (const component of line.components) {
    const sign = component.amountPaise < 0 ? '-' : '+';
    console.log(
      `${component.kind.padEnd(11)} ${component.label.slice(0, 40).padEnd(42)} ${sign}${formatINR(Math.abs(component.amountPaise), { decimals: 'always' }).padStart(13)}`,
    );
  }

  console.log('-'.repeat(78));
  console.log(
    `${'LINE TOTAL'.padEnd(54)} ${formatINR(line.totalPaise, { decimals: 'always' }).padStart(14)}`,
  );

  for (const component of breakdown.components) {
    const sign = component.amountPaise < 0 ? '-' : '+';
    console.log(
      `${component.kind.padEnd(11)} ${component.label.slice(0, 40).padEnd(42)} ${sign}${formatINR(Math.abs(component.amountPaise), { decimals: 'always' }).padStart(13)}`,
    );
  }

  console.log('='.repeat(78));
  console.log(
    `${'GRAND TOTAL'.padEnd(54)} ${formatINR(breakdown.grandTotalPaise, { decimals: 'always' }).padStart(14)}`,
  );
  console.log('');
  console.log(
    `subtotal ${breakdown.subtotalPaise}  discount ${breakdown.discountPaise}  shipping ${breakdown.shippingPaise}  ` +
      `tax ${breakdown.taxPaise} (cgst ${breakdown.taxSplit.cgstPaise} / sgst ${breakdown.taxSplit.sgstPaise} / igst ${breakdown.taxSplit.igstPaise})  ` +
      `rounding ${breakdown.roundingPaise}  total ${breakdown.grandTotalPaise}`,
  );
  console.log(
    `place of supply ${breakdown.placeOfSupply.sellerStateCode} -> ${breakdown.placeOfSupply.buyerStateCode} ` +
      `(${breakdown.placeOfSupply.isIntraState ? 'intra-state' : 'inter-state'})  engine v${breakdown.engineVersion}  hash ${breakdown.contextHash.slice(0, 16)}…`,
  );

  await prisma.$disconnect();
}

void main();
