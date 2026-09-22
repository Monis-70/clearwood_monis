import { SYSTEM_MEDIA_FOLDERS } from '@shared/constants';

import { slugify } from '../../src/utils/slug';

import { log, prisma } from './context';

/**
 * The fixed top-level folders of the media library. They are flagged `isSystem`, which the
 * MediaFolder service refuses to rename or delete — every other folder is admin-managed.
 *
 * Structural, not demo data: it runs regardless of SEED_DEMO so uploads always have a home.
 */
export async function seedMediaFolders(): Promise<void> {
  let created = 0;

  for (const [index, name] of SYSTEM_MEDIA_FOLDERS.entries()) {
    const slug = slugify(name);
    const existing = await prisma.mediaFolder.findFirst({ where: { path: slug } });

    if (existing) {
      // Keep structure in sync, leave the (admin-editable) display name alone.
      await prisma.mediaFolder.update({
        where: { id: existing.id },
        data: { depth: 0, parentId: null, position: index, isSystem: true, deletedAt: null },
      });
      continue;
    }

    await prisma.mediaFolder.create({
      data: {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        slug,
        path: slug,
        depth: 0,
        position: index,
        isSystem: true,
      },
    });
    created += 1;
  }

  log(
    'media-folders',
    `${SYSTEM_MEDIA_FOLDERS.length} system folders ensured (${created} created)`,
  );
}
