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

export async function seedSearchSynonyms(): Promise<void> {
  for (const entry of SYNONYMS) {
    const synonymsJson = JSON.stringify(entry.synonyms);

    await prisma.searchSynonym.upsert({
      where: { term: entry.term },
      // Structural: the expansion set is kept in sync, an admin's isActive flag is not touched.
      update: { synonymsJson, isTwoWay: entry.isTwoWay ?? true },
      create: {
        term: entry.term,
        synonymsJson,
        isTwoWay: entry.isTwoWay ?? true,
        isActive: true,
        note: entry.note ?? null,
      },
    });
  }

  log('search-synonyms', `${SYNONYMS.length} synonym sets ensured`);
}
