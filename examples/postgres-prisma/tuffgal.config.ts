import { defineConfig } from 'tuffgal';
import { exampleFixture, resetTestDatabase } from './tuffgal/database.ts';

/**
 * Example Tuffgal config for a Postgres + Prisma stack. Adapt to your
 * project by:
 *   1. Editing `tuffgal/database.ts` to match your schema.
 *   2. Pointing `baseUrl` + `devServers` at your dev stack.
 *   3. Declaring whichever fixtures your stories need.
 */
export default defineConfig({
  paths: {
    actions: 'tuffgal/actions',
    stories: 'tuffgal/stories',
    baselines: 'tuffgal/baselines',
    report: 'tuffgal/report',
    authState: 'tuffgal/.auth',
  },

  baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  apiHost: 'http://localhost:3000',
  storageStatePins: ['session_token'],

  viewport: { width: 1280, height: 800 },
  defaultTimeoutMs: 10_000,
  navigationTimeoutMs: 15_000,
  frozenTime: '2026-01-15T12:00:00.000Z',

  database: {
    reset: resetTestDatabase,
    fixtures: {
      'example-rows': exampleFixture,
    },
  },

  devServers: {
    command: 'npm run dev:test',
    healthCheck: [
      { url: 'http://localhost:3000', timeoutMs: 120_000 },
      { url: 'http://localhost:5173', timeoutMs: 120_000 },
    ],
  },
});
