import { ROLES, resolveRolePermissions } from './data/roles';
import { log, prisma } from './context';

/**
 * Idempotent in the way that matters for a live system: newly introduced permissions are ADDED to
 * a role, but a grant an admin deliberately revoked in the UI is never silently restored.
 */
export async function seedRoles(): Promise<void> {
  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, code: true } })).map((row) => [
      row.code,
      row.id,
    ]),
  );

  const summary: string[] = [];

  for (const role of ROLES) {
    const row = await prisma.role.upsert({
      where: { code: role.code },
      update: { isSystem: true, position: role.position },
      create: {
        code: role.code,
        name: role.name,
        description: role.description,
        position: role.position,
        isSystem: true,
      },
    });

    const codes = resolveRolePermissions(role);
    const existing = await prisma.rolePermission.findMany({
      where: { roleId: row.id },
      select: { permissionId: true },
    });
    const have = new Set(existing.map((grant) => grant.permissionId));

    const missing = codes
      .map((code) => permissionIds.get(code))
      .filter((id): id is string => Boolean(id) && !have.has(id!));

    if (missing.length > 0) {
      await prisma.rolePermission.createMany({
        data: missing.map((permissionId) => ({ roleId: row.id, permissionId })),
      });
    }

    summary.push(`${role.code}=${codes.length}`);
  }

  log('roles', `${ROLES.length} roles upserted (${summary.join(', ')})`);
}
