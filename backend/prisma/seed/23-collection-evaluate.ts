import { collectionRulesService } from '../../src/container';

import { log } from './context';

/**
 * Finally materialises the AUTOMATIC collections Prompt 2 seeded rules for. CollectionProduct was
 * empty until this ran; evaluation is idempotent and preserves manual position overrides.
 */
export async function seedCollectionMembership(): Promise<void> {
  const results = await collectionRulesService.evaluateAll();
  const matched = results.reduce((total, result) => total + result.matched, 0);

  log(
    'collection-evaluate',
    `${results.length} automatic collections evaluated, ${matched} memberships`,
  );
}
