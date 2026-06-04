import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as bcrypt from 'bcryptjs';
import pg from 'pg';
import { TEST_USER } from './database.ts';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/myapp_testing_ui';

const TEST_DB_NAME = 'myapp_testing_ui';
const BCRYPT_ROUNDS = 10;

const execFileAsync = promisify(execFile);

/**
 * One-shot bootstrap for the dedicated test database. Idempotent: safe to
 * run repeatedly. Creates the database if missing, runs every committed
 * Prisma migration, and upserts the deterministic test user. Subsequent
 * test runs reset state through `database.reset` in `tuffgal.config.ts` —
 * they no longer touch this script.
 *
 * Wire from your project's package.json:
 *
 *   "test:ui:setup": "node --experimental-strip-types tuffgal/setup.ts"
 */
async function main(): Promise<void> {
  await createTestDatabaseIfMissing();
  await runMigrations();
  await seedTestUser();
  process.stdout.write(
    `Test database ready: ${TEST_DB_NAME}\n` +
      `Seeded user: ${TEST_USER.email}\n`,
  );
}

async function createTestDatabaseIfMissing(): Promise<void> {
  const adminUrl = withDatabase(TEST_DATABASE_URL, 'postgres');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ exists: boolean }>(
      'SELECT 1 AS exists FROM pg_database WHERE datname = $1',
      [TEST_DB_NAME],
    );
    if (rows.length === 0) {
      // Identifiers cannot be parameterised. Whitelisted constant is safe.
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
      process.stdout.write(`Created database ${TEST_DB_NAME}.\n`);
    } else {
      process.stdout.write(`Database ${TEST_DB_NAME} already exists.\n`);
    }
  } finally {
    await admin.end();
  }
}

async function runMigrations(): Promise<void> {
  process.stdout.write('Applying Prisma migrations…\n');
  await execFileAsync(
    'npx',
    ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      // Adjust if your Prisma schema lives elsewhere.
      cwd: process.env.PRISMA_PROJECT_DIR ?? process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    },
  );
  process.stdout.write('Migrations applied.\n');
}

async function seedTestUser(): Promise<void> {
  const passwordHash = await bcrypt.hash(TEST_USER.password, BCRYPT_ROUNDS);
  const now = new Date();
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `
      INSERT INTO "User"
        ("id", "email", "passwordHash", "updatedAt")
      VALUES ($1, $2, $3, $4)
      ON CONFLICT ("id") DO UPDATE
        SET "passwordHash" = EXCLUDED."passwordHash",
            "updatedAt"    = EXCLUDED."updatedAt"
      `,
      [TEST_USER.id, TEST_USER.email, passwordHash, now],
    );
    process.stdout.write(`Seeded ${TEST_USER.email} (id=${TEST_USER.id}).\n`);
  } finally {
    await client.end();
  }
}

function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

main().catch((error) => {
  process.stderr.write(
    `tuffgal setup error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
