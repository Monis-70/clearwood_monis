import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The repository has to build on Ubuntu, and has only ever been run on Windows.
 *
 * Three things break silently when a Windows-developed repo first meets Linux:
 *
 *   CASE. Windows filesystems are case-insensitive, so `import './Foo'` happily resolves to
 *   `foo.ts` on a laptop and fails at runtime on a server. Nothing catches it until deploy.
 *
 *   PATH SEPARATORS. A backslash in an import or a glob is a literal character on Linux.
 *
 *   ABSOLUTE PATHS. A drive letter in committed code is meaningless on a server.
 *
 * These assertions are cheap and they run on every machine, including the Windows one where the
 * mistake would otherwise be invisible.
 */

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

function collect(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;

    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(full)) files.push(full);
  }

  return files;
}

const sources = [...collect(path.join(backendRoot, 'src')), ...collect(path.join(backendRoot, 'tests'))];

/** Relative specifiers only, and only real ones: `.*config/prisma` is a regex, not an import. */
function relativeImports(text: string): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
    found.push(match[1]!);
  }

  return found;
}

describe('the repository builds on a case-sensitive filesystem', () => {
  it('scanned a realistic number of source files', () => {
    // G1: an empty scan would make every assertion below vacuous.
    expect(sources.length).toBeGreaterThan(200);
  });

  it('resolves every relative import to a file with exactly that case', () => {
    const broken: string[] = [];

    for (const file of sources) {
      const dir = path.dirname(file);

      for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
        const base = path.resolve(dir, specifier);

        const candidates = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.mts`,
          `${base}.js`,
          path.join(base, 'index.ts'),
          path.join(base, 'index.js'),
        ];

        const resolved = candidates.find((candidate) => existsSync(candidate));
        if (!resolved) continue;

        // existsSync is case-INSENSITIVE on Windows, so compare against the real directory entry.
        const parent = path.dirname(resolved);
        const wanted = path.basename(resolved);

        if (!readdirSync(parent).includes(wanted)) {
          broken.push(`${path.relative(repoRoot, file)} imports '${specifier}'`);
        }
      }
    }

    expect(
      broken,
      'These imports only resolve because Windows ignores case. They will fail on Linux.',
    ).toEqual([]);
  });

  it('uses no backslash in a relative import', () => {
    const offenders: string[] = [];

    for (const file of sources) {
      for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
        if (specifier.includes('\\')) {
          offenders.push(`${path.relative(repoRoot, file)}: '${specifier}'`);
        }
      }
    }

    expect(offenders, 'A backslash is a literal character in a Linux path.').toEqual([]);
  });

  it('commits no drive letter or Windows user path', () => {
    const offenders: string[] = [];

    for (const file of sources) {
      const text = readFileSync(file, 'utf8');

      text.split(/\r?\n/).forEach((line, index) => {
        if (/(?:^|['"`\s(])[A-Za-z]:[\\/](?:Users|Program|Windows)/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }

    expect(offenders, 'An absolute Windows path means nothing on a server.').toEqual([]);
  });

  it('keeps native modules out of anything that could be copied between platforms', () => {
    const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

    // sharp and argon2 ship compiled binaries; a Windows node_modules is useless on Linux.
    expect(gitignore).toMatch(/(^|\n)\s*node_modules\/?\s*(\n|$)/);
    expect(gitignore).toMatch(/(^|\n)\s*dist\/?\s*(\n|$)/);
  });
});
