import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bcrypt from 'bcryptjs';
import pg from 'pg';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_DIR = join(moduleDir, '.auth');

/**
 * Connection string for the dedicated test database. Read from env so the
 * same recipe works in CI without code changes. Set this in `.env.test` or
 * the CI job's environment. Never point at a real database.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/myapp_testing_ui';

const EXPECTED_DB_NAME = 'myapp_testing_ui';
const PROTECTED_TABLES = new Set(['_prisma_migrations']);
const BCRYPT_ROUNDS = 10;

export const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'testing@example.test',
  password: 'correct-horse-battery-staple',
} as const;

/**
 * Truncates every public-schema table other than `_prisma_migrations`,
 * then re-inserts the deterministic test user. Wipes the cached storage
 * state so the first story that produces `logged-in` runs through the real
 * login flow against fresh rows.
 *
 * Wired to `database.reset` in `tuffgal.config.ts`. Tuffgal calls this once
 * before scheduling the first story.
 */
export async function resetTestDatabase(): Promise<void> {
  guardAgainstWrongDatabase(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const tables = await listDataTables(client);
    if (tables.length > 0) {
      const quoted = tables.map((table) => `"${table}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    }
    await seedDeterministicUser(client);
  } finally {
    await client.end();
  }
  await rm(AUTH_STATE_DIR, { recursive: true, force: true });
}

/**
 * Example fixture. Stories that declare `fixtures: ["example-rows"]` will
 * see these rows pre-loaded into the test database. Each fixture must be
 * idempotent (use `ON CONFLICT DO NOTHING`) — Tuffgal applies fixtures per
 * story without per-story DB reset.
 */
export async function exampleFixture(): Promise<void> {
  guardAgainstWrongDatabase(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        INSERT INTO "Example" ("id", "userId", "label")
        VALUES ('fixture-example-001', $1, 'Example row')
        ON CONFLICT ("id") DO NOTHING
        `,
        [TEST_USER.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

function guardAgainstWrongDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const dbName = url.pathname.replace(/^\//, '');
  if (dbName !== EXPECTED_DB_NAME) {
    throw new Error(
      `Refusing to operate on database "${dbName}" — only "${EXPECTED_DB_NAME}" is allowed. ` +
        `Check that TEST_DATABASE_URL has not been changed.`,
    );
  }
}

async function listDataTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    `
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
    `,
  );
  return rows
    .map((row) => row.tablename)
    .filter((name) => !PROTECTED_TABLES.has(name));
}

async function seedDeterministicUser(client: pg.Client): Promise<void> {
  const passwordHash = await bcrypt.hash(TEST_USER.password, BCRYPT_ROUNDS);
  const now = new Date();
  await client.query(
    `
    INSERT INTO "User"
      ("id", "email", "passwordHash", "updatedAt")
    VALUES ($1, $2, $3, $4)
    `,
    [TEST_USER.id, TEST_USER.email, passwordHash, now],
  );
}
