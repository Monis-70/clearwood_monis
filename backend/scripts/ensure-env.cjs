// Creates backend/.env from .env.example on first install so that `prisma generate`
// (which needs DATABASE_PROVIDER) and `npm run dev` work on a clean checkout.
// Never overwrites an existing .env.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
const template = path.join(root, '.env.example');

if (fs.existsSync(target)) {
  process.exit(0);
}

if (!fs.existsSync(template)) {
  console.error('[env] backend/.env.example is missing — cannot bootstrap backend/.env');
  process.exit(1);
}

fs.copyFileSync(template, target);
console.log('[env] created backend/.env from .env.example');
