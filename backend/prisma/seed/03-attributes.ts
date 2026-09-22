import { ATTRIBUTES, ATTRIBUTE_GROUPS } from './data/attributes';
import { log, prisma } from './context';

/**
 * Structure (input type, flags, ordering) is kept in sync on every run; editorial content
 * (`name`, `label`, `helpText`, a tweaked `colorHex`) is written once and then left alone.
 */
export async function seedAttributes(): Promise<void> {
  const groupIds = new Map<string, string>();

  for (const [index, group] of ATTRIBUTE_GROUPS.entries()) {
    const row = await prisma.attributeGroup.upsert({
      where: { code: group.code },
      update: { position: index + 1 },
      create: { code: group.code, name: group.name, position: index + 1 },
    });
    groupIds.set(group.code, row.id);
  }

  let valueCount = 0;

  for (const [index, attribute] of ATTRIBUTES.entries()) {
    const structure = {
      groupId: groupIds.get(attribute.groupCode) ?? null,
      inputType: attribute.inputType,
      dataType: attribute.dataType ?? 'STRING',
      unit: attribute.unit ?? null,
      isVariantDefining: attribute.isVariantDefining ?? false,
      isFilterable: attribute.isFilterable ?? true,
      isSearchable: attribute.isSearchable ?? false,
      isComparable: attribute.isComparable ?? false,
      showInSwatch: attribute.showInSwatch ?? false,
      position: index + 1,
      deletedAt: null,
    };

    const row = await prisma.attribute.upsert({
      where: { code: attribute.code },
      update: structure,
      create: {
        code: attribute.code,
        name: attribute.name,
        helpText: attribute.helpText ?? null,
        ...structure,
      },
    });

    for (const [valueIndex, value] of attribute.values.entries()) {
      await prisma.attributeValue.upsert({
        where: { attributeId_code: { attributeId: row.id, code: value.code } },
        update: {
          position: valueIndex + 1,
          numericValue: value.numericValue ?? null,
          deletedAt: null,
        },
        create: {
          attributeId: row.id,
          code: value.code,
          label: value.label,
          position: valueIndex + 1,
          colorHex: value.colorHex ?? null,
          numericValue: value.numericValue ?? null,
        },
      });
      valueCount += 1;
    }
  }

  log(
    'attributes',
    `${ATTRIBUTE_GROUPS.length} groups, ${ATTRIBUTES.length} attributes, ${valueCount} values upserted`,
  );
}
