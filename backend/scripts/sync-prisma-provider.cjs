// D1 — the Prisma datasource provider is owned by DATABASE_PROVIDER.
//
// Prisma rejects `provider = env("DATABASE_PROVIDER")` ("a datasource must not use the env()
// function in the provider argument"), so this script is the one place that applies the env value
// to schema.prisma. It runs before every generate/migrate, which keeps switching sqlite -> mysql a
// config change (docs/DB_MIGRATION_PLAN.md) instead of a manual schema edit.
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['mysql'];

const backendRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(backendRoot, 'prisma', 'schema.prisma');
const envPath = path.join(backendRoot, '.env');

function readProviderFromEnvFile() {
  if (!fs.existsSync(envPath)) return undefined;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*DATABASE_PROVIDER\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const provider = (process.env.DATABASE_PROVIDER || readProviderFromEnvFile() || 'sqlite').trim();

if (!SUPPORTED.includes(provider)) {
  console.error(
    `[prisma] DATABASE_PROVIDER="${provider}" is not supported. Use one of: ${SUPPORTED.join(', ')}`,
  );
  process.exit(1);
}

const schema = fs.readFileSync(schemaPath, 'utf8');
const datasource = /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*")([^"]+)(")/;

if (!datasource.test(schema)) {
  console.error('[prisma] could not find the datasource provider in prisma/schema.prisma');
  process.exit(1);
}

const current = datasource.exec(schema)[2];

if (current === provider) {
  process.exit(0);
}

fs.writeFileSync(schemaPath, schema.replace(datasource, `$1${provider}$3`), 'utf8');
console.log(`[prisma] datasource provider switched ${current} -> ${provider}`);
