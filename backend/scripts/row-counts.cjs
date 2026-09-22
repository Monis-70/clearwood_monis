// Prints a row count per model. Used by the README verification steps and the delivery report.
const { PrismaClient } = require('@prisma/client');

const MODELS = [
  'appSetting',
  'auditLog',
  'taxClass',
  'brand',
  'media',
  'mediaVariant',
  'attributeGroup',
  'attribute',
  'attributeValue',
  'category',
  'categoryAttribute',
  'product',
  'productCategory',
  'productAttributeValue',
  'productVariant',
  'variantAttributeValue',
  'productMedia',
  'priceAdjustment',
  'collection',
  'collectionProduct',
  'navigationMenu',
  'navigationItem',
];

const prisma = new PrismaClient();

async function main() {
  const counts = {};
  for (const model of MODELS) {
    counts[model] = await prisma[model].count();
  }
  console.table(counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
