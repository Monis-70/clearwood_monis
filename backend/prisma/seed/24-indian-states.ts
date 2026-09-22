import { INDIAN_STATES } from '@shared/constants';

import { log, prisma } from './context';

/**
 * The canonical list of Indian states and union territories, with their GST state codes.
 *
 * Structural, not demo data: address validation (Prompt 8) and the place-of-supply decision that
 * picks CGST+SGST over IGST (Prompt 6) both need it, so it must exist on every install. It is
 * published as a single public AppSetting so the storefront can populate a state dropdown without
 * shipping its own copy — one list, one source of truth.
 *
 * `INDIAN_STATES` in shared/ stays the master; this step only mirrors it into the database.
 */

const KEY = 'address.indian_states';

export async function seedIndianStates(): Promise<void> {
  const value = JSON.stringify(INDIAN_STATES);

  await prisma.appSetting.upsert({
    where: { key: KEY },
    // Unlike editorial settings this one IS resynced: it is reference data, not an admin's choice.
    update: { value, group: 'address', valueType: 'json', isPublic: true },
    create: { key: KEY, value, group: 'address', valueType: 'json', isPublic: true },
  });

  log('indian-states', `${INDIAN_STATES.length} states and union territories ensured`);
}
