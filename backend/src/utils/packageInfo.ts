import { readFileSync } from 'node:fs';
import path from 'node:path';

import { logger } from '../config/logger';

/**
 * `src/` and `dist/` sit at the same depth under backend/, so one relative path works for both
 * `tsx` (development) and the compiled build.
 */
const PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'package.json');

let version: string | null = null;

export function readPackageVersion(): string {
  if (version) return version;

  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
    version = parsed.version ?? '0.0.0';
  } catch (error) {
    logger.warn({ err: error }, 'could not read backend/package.json version');
    version = '0.0.0';
  }

  return version;
}
