import { ATTRIBUTES, ATTRIBUTE_GROUPS } from './data/attributes';
import { log, prisma } from './context';

/**
 * CREATE-ONLY. Once a group, attribute or value exists it is the admin's: its flags, ordering,
 * labels and colours are never rewritten, and a deleted one stays deleted. A re-run only adds
 * what is missing, so a deploy can extend the dictionary but never undo an admin's edit.
 *
 * Groups are HARD-deleted by the admin API, so a missing group is indistinguishable from a removed
 * one. A group is therefore only (re)created alongside a new attribute that needs it.
 */
export async function seedAttributes(): Promise<void> {
  const existingCodes = new Set(
    (
      await prisma.attribute.findMany({
        where: { code: { in: ATTRIBUTES.map((attribute) => attribute.code) } },
        select: { code: true },
      })
    ).map((row) => row.code),
  );
  const neededGroups = new Set(
    ATTRIBUTES.filter((attribute) => !existingCodes.has(attribute.code)).map(
      (attribute) => attribute.groupCode,
    ),
  );

  const groupIds = new Map<string, string>();

  for (const [index, group] of ATTRIBUTE_GROUPS.entries()) {
    if (!neededGroups.has(group.code)) continue;

    const row = await prisma.attributeGroup.upsert({
      where: { code: group.code },
      update: {},
      create: { code: group.code, name: group.name, position: index + 1 },
    });
    groupIds.set(group.code, row.id);
  }

  let valueCount = 0;

  for (const [index, attribute] of ATTRIBUTES.entries()) {
    const row = await prisma.attribute.upsert({
      where: { code: attribute.code },
      update: {},
      create: {
        code: attribute.code,
        name: attribute.name,
        helpText: attribute.helpText ?? null,
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
      },
    });

    for (const [valueIndex, value] of attribute.values.entries()) {
      await prisma.attributeValue.upsert({
        where: { attributeId_code: { attributeId: row.id, code: value.code } },
        update: {},
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
    `${ATTRIBUTE_GROUPS.length} groups, ${ATTRIBUTES.length} attributes, ${valueCount} values ensured`,
  );
}
