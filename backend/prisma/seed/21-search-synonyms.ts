import { log, prisma } from './context';

/**
 * Query expansion for the way Indian furniture shoppers actually type.
 *
 * Two-way entries also map a synonym back to the term, so "couch" finds sofas and "sofa" finds
 * anything filed under couch. One-way entries only fire when the term itself is typed.
 */

interface SeedSynonym {
  term: string;
  synonyms: string[];
  isTwoWay?: boolean;
  note?: string;
}

const SYNONYMS: SeedSynonym[] = [
  { term: 'sofa', synonyms: ['couch', 'settee', 'sofa set'] },
  { term: 'l shaped', synonyms: ['sectional', 'corner sofa', 'l-shape', 'lshaped'] },
  { term: 'u shaped', synonyms: ['u-shape', 'ushaped', 'horseshoe'] },
  { term: 'diwan', synonyms: ['daybed', 'divan', 'day bed'] },
  { term: 'pouffe', synonyms: ['ottoman', 'footstool', 'puffy', 'pouf'] },
  { term: 'recliner', synonyms: ['lazyboy', 'lazy boy', 'reclining chair'] },
  { term: 'teak', synonyms: ['teakwood', 'sagwan', 'saagwan'] },
  { term: 'sheesham', synonyms: ['rosewood', 'shisham'] },
  { term: '3 seater', synonyms: ['three seater', '3-seater', 'threeseater'] },
  { term: '2 seater', synonyms: ['two seater', '2-seater', 'twoseater'] },
  { term: 'almirah', synonyms: ['wardrobe', 'cupboard', 'almari'] },
  { term: 'centre table', synonyms: ['coffee table', 'center table', 'tea table'] },
  { term: 'side table', synonyms: ['end table', 'lamp table', 'accent table'] },
  { term: 'cot', synonyms: ['bed', 'palang'] },
  { term: 'mattress', synonyms: ['gadda', 'matress', 'bed mattress'] },
  { term: 'swing', synonyms: ['jhula', 'hanging chair', 'hammock chair'] },
  { term: 'stool', synonyms: ['bar stool', 'mudda', 'counter stool'] },
  { term: 'bench', synonyms: ['settle', 'dining bench'] },
  { term: 'armchair', synonyms: ['arm chair', 'accent chair', 'easy chair'] },
  { term: 'wingback', synonyms: ['wing chair', 'wing back'] },
  { term: 'dining set', synonyms: ['dining table set', 'khana table', 'dinette'] },
  { term: 'balcony', synonyms: ['terrace', 'patio', 'verandah'] },
  { term: 'outdoor', synonyms: ['garden', 'patio', 'lawn'] },
  { term: 'leather', synonyms: ['leatherette', 'rexine', 'faux leather'], isTwoWay: false },
  { term: 'boucle', synonyms: ['bouclé', 'textured weave'] },
  { term: 'office chair', synonyms: ['desk chair', 'task chair', 'revolving chair'] },
  { term: 'sofa cum bed', synonyms: ['sofa bed', 'sofa-cum-bed', 'futon'] },
];

/**
 * Seeded ONCE, then admin-managed. Synonyms are hard-deleted by the admin API, so "missing" cannot
 * be told apart from "removed"; a marker setting records which starter set was written, and a
 * re-run neither rewrites an edited expansion nor brings back a deleted term.
 */
const SEEDED_MARKER = 'seed.search_synonyms';
const STARTER_SET = 'starter-set-v1';

export async function seedSearchSynonyms(): Promise<void> {
  const marker = await prisma.appSetting.findUnique({ where: { key: SEEDED_MARKER } });
  if (marker) {
    log('search-synonyms', `${marker.value} already seeded; synonyms are the admin's now`);
    return;
  }

  // An install seeded before the marker existed already has its synonyms: mark, do not re-add.
  const existing = await prisma.searchSynonym.count();
  if (existing === 0) {
    await prisma.searchSynonym.createMany({
      data: SYNONYMS.map((entry) => ({
        term: entry.term,
        synonymsJson: JSON.stringify(entry.synonyms),
        isTwoWay: entry.isTwoWay ?? true,
        isActive: true,
        note: entry.note ?? null,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.appSetting.create({
    data: {
      key: SEEDED_MARKER,
      value: STARTER_SET,
      group: 'seed',
      valueType: 'string',
      isPublic: false,
    },
  });

  log(
    'search-synonyms',
    existing === 0
      ? `${SYNONYMS.length} synonym sets seeded`
      : `${existing} existing synonym sets kept; marked as seeded`,
  );
}
