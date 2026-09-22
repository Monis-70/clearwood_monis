/**
 * The test suite may only ever point at a local database.
 *
 * `global-setup.ts` falls back to `DATABASE_URL` from `backend/.env`, and the intention is for
 * that variable to point at the hosted database. Without this guard, `npm test` would create and
 * drop `clearwood_test_*` databases on production, fifty-one files in parallel. Today that fails
 * only because `clearwood_app` has no CREATE DATABASE privilege on the host - which is an accident
 * of configuration, not a control, and it will stop being true the moment someone grants it.
 *
 * HOST ALONE IS NOT ENOUGH, and that is the whole reason this file exists. The SSH tunnel makes
 * production answer on `127.0.0.1:3307`, so a hostname check would wave it straight through. The
 * allowlist is host AND port.
 *
 * CI can widen it deliberately with `CLEARWOOD_TEST_ALLOWED_HOSTS` (comma-separated `host:port`).
 * Nothing widens it accidentally.
 */

export const DEFAULT_ALLOWED_TARGETS = ['127.0.0.1:3306', 'localhost:3306'];

/** Never a test target, whatever host it is reached through. */
const FORBIDDEN_DATABASES = ['clearwood_prod'];

export interface TestTarget {
  host: string;
  port: number;
  database: string;
}

export function allowedTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CLEARWOOD_TEST_ALLOWED_HOSTS;
  if (!override) return DEFAULT_ALLOWED_TARGETS;

  return override
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Throws unless the URL points somewhere it is safe to create and drop databases.
 *
 * The message names the host and the port and nothing else - never the URL, the user or the
 * password, which is the rule `tests/no-connection-strings.test.ts` enforces repo-wide.
 */
export function assertLocalTestTarget(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): TestTarget {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The test database URL could not be parsed.');
  }

  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || 3306);
  const database = parsed.pathname.replace(/^\//, '');

  if (FORBIDDEN_DATABASES.includes(database)) {
    throw new Error(
      `Refusing to run the test suite against the database "${database}". The suite creates and ` +
        'drops databases; it must never be pointed at production.',
    );
  }

  const permitted = allowedTargets(env);

  if (!permitted.includes(`${host}:${port}`)) {
    throw new Error(
      `Refusing to run the test suite against ${host}:${port}. The suite creates and drops ` +
        `clearwood_test_* databases, so it is restricted to ${permitted.join(' or ')}. ` +
        'Note that the SSH tunnel puts production on 127.0.0.1:3307, which is why the port is ' +
        'checked as well as the host. Set CLEARWOOD_TEST_ALLOWED_HOSTS to widen this on purpose.',
    );
  }

  return { host, port, database };
}
