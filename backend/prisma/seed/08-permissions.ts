import { PERMISSION_CODES, isDangerousPermission, permissionGroup } from '@shared/enums';

import { log, prisma } from './context';

/** Every code in the registry becomes a row. Adding a permission is a seed change, never a guard. */
export async function seedPermissions(): Promise<void> {
  let dangerous = 0;

  for (const code of PERMISSION_CODES) {
    const [group, resource, action] = code.split('.');
    const isDangerous = isDangerousPermission(code);
    if (isDangerous) dangerous += 1;

    await prisma.permission.upsert({
      where: { code },
      // Group and danger flag are derived, so they are always resynced; the label is editorial.
      update: { group: permissionGroup(code), isDangerous },
      create: {
        code,
        name: `${action} ${resource}`.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        group: group ?? 'other',
        isDangerous,
        description: `Allows ${action} on ${group}.${resource}.`,
      },
    });
  }

  log('permissions', `${PERMISSION_CODES.length} permissions upserted (${dangerous} dangerous)`);
}
