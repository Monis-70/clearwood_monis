import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.vite/**',
      'backend/prisma/migrations/**',
      'shared/tailwind-preset.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['backend/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  /**
   * An UNVERIFIED integration may only be reached through its driver factory.
   *
   * The env gate keeps it inert until it is enabled and verified, but nothing stopped a developer
   * importing the class directly and quietly depending on endpoint paths that have never been
   * validated. The factory is the one place that is allowed to know it exists.
   */
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['backend/src/drivers/shipping/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/*.UNVERIFIED', '**/*.UNVERIFIED.*'],
              message:
                'This integration has never been validated against a live account. Import it only through its driver factory (drivers/shipping/index.ts), and see the Prompt 17 go-live checklist in docs/PROJECT_CONTEXT.md §19 before enabling it.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * Prompt B1 Task 1 — a middleware FACTORY passed to Express as a handler.
     *
     * Express calls it with (req, res, next), throws away the handler it returns, and never calls
     * next. The request then hangs until the timeout. It has happened three times on this project
     * (idempotency, optionalAuth, and one earlier), and TypeScript does not catch it: a probe
     * confirmed that both `const h: RequestHandler = optionalAuth` and `router.get('/x',
     * optionalAuth)` compile clean, because Express's call signature is checked bivariantly.
     *
     * So it is caught here instead, and again at runtime by the arity self-check in
     * `tests/middleware-contract.test.ts`.
     */
    files: ['backend/src/routes/**/*.ts', 'backend/src/app.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(get|post|put|patch|delete|options|head|all|use)$/] > Identifier.arguments[name=/^(authenticate|optionalAuth|idempotency|validate|requirePermission|requireAnyPermission|requireAllPermissions|requireRole|authRateLimit|csrfProtection)$/]",
          message:
            'This is a middleware FACTORY, not a handler. Call it: authenticate("ADMIN"), ' +
            'idempotency("scope"), validate({ body }). Passing it bare makes Express discard the ' +
            'handler and the request hangs until it times out.',
        },
      ],
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Build scripts and tool configs (tailwind/postcss/eslint) are plain CommonJS/ESM Node files.
    files: ['**/*.{cjs,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
