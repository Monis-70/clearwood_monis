// The `@shared/*` alias is an authoring convenience (tsconfig `paths`); TypeScript never rewrites
// it, so the compiled output would still `require("@shared/enums")`. This step maps the alias onto
// the real workspace package, which Node resolves through @clearwood/shared's `exports` map.
// Run after `tsc -p tsconfig.build.json`; `shared` must be built first (the root build does that).
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist');
const ALIAS = /(require\(\s*["'])@shared\//g;
const REPLACEMENT = '$1@clearwood/shared/';

if (!fs.existsSync(distDir)) {
  console.error('[build] dist/ does not exist — run tsc first');
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.js')) yield full;
  }
}

let rewritten = 0;

for (const file of walk(distDir)) {
  const source = fs.readFileSync(file, 'utf8');
  if (!ALIAS.test(source)) continue;
  ALIAS.lastIndex = 0;

  fs.writeFileSync(file, source.replace(ALIAS, REPLACEMENT), 'utf8');
  rewritten += 1;
}

console.log(`[build] rewrote @shared/* -> @clearwood/shared/* in ${rewritten} file(s)`);
