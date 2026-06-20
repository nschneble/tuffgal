# Postgres + Prisma example

This is the canonical Tuffgal recipe for a project backed by Postgres and Prisma. It mirrors the production setup used by [Linklater](https://github.com/nschneble/linklater), the first Tuffgal consumer, stripped of any app-specific schema.

Copy the `tuffgal/` directory and `tuffgal.config.ts` into your project root, then walk through the integration steps below.

The bridge files import two runtime dependencies that your project must have installed:

```bash
npm install pg bcryptjs
npm install -D @types/pg  # if your project is TypeScript
```

See [Why `bcryptjs`?](#why-bcryptjs) and [Why pure `pg`, not Prisma client?](#why-pure-pg-not-prisma-client) below for the rationale, and how to substitute if you already use `bcrypt` or another client.

## What's in the box

```
examples/postgres-prisma/
├─ tuffgal.config.ts              # consumer-side Tuffgal config
└─ tuffgal/
   ├─ database.ts                 # resetTestDatabase + one example fixture
   └─ setup.ts                    # one-time DB bootstrap (create + migrate + seed)
```

`tuffgal/database.ts` and `tuffgal/setup.ts` together are roughly 200 lines. That's the entire DB-bridge surface area on the consumer side.

## Integration steps

1. **Pick a dedicated test database name.** Never point at your dev database. Set the env var `TEST_DATABASE_URL` (default in the example is `postgres://postgres:postgres@localhost:5432/myapp_testing_ui`). Update the `EXPECTED_DB_NAME` and `TEST_DB_NAME` constants to match. The `guardAgainstWrongDatabase` helper refuses to operate on anything else.

2. **Add the test-mode contract to your app.** Your dev server needs a way to skip rate limiters, background jobs, and external API calls when running under the harness. See [docs/app-contract.md](../../docs/app-contract.md). A common pattern: `TUFFGAL=1` env var, checked at startup.

3. **Add `tuffgal/setup.ts` script.** Wire it into your `package.json`:

   ```json
   "scripts": {
     "test:ui": "tuffgal run",
     "test:ui:approve": "tuffgal approve",
     "test:ui:setup": "node --experimental-strip-types tuffgal/setup.ts"
   }
   ```

   Run `npm run test:ui:setup` once per machine (and in CI per job).

4. **Write your fixtures.** The example exposes `exampleFixture` as a starting template. Each fixture is a `() => Promise<void>` that opens its own `pg.Client`, applies idempotent inserts (`ON CONFLICT DO NOTHING`), and closes the client. Register it in `tuffgal.config.ts` under `database.fixtures.<name>`, then reference it from a story:

   ```json
   { "story": "...", "fixtures": ["example-rows"], "actions": [...] }
   ```

5. **Write your stories + actions** under `tuffgal/stories/` and `tuffgal/actions/`. See [docs/authoring.md](../../docs/authoring.md) for the full authoring guide.

## Why two files, not one?

`setup.ts` runs once per environment to provision a database and apply schema migrations. `database.ts` runs on every `tuffgal run` to wipe data and reseed the deterministic user. They have different lifecycles, so they live in different files.

If your project has no migrations or you provision DBs some other way (Docker compose, ephemeral containers per CI job), you can drop `setup.ts` entirely. Only `database.ts` is required for the bridge.

## Why `bcryptjs`?

The example seeds a deterministic test user with a hashed password. `bcryptjs` is pure JS and works in any Node environment without native build steps. If your project already uses `bcrypt` (native bindings), you can substitute.

## Why pure `pg`, not Prisma client?

Three reasons:

1. The harness operates on the schema, not the model. Pure SQL lets you `TRUNCATE … CASCADE` cleanly without round-tripping through generated Prisma types.
2. Test reset code does not need type safety — it's deliberately destructive.
3. Avoids an additional code-generation step at harness startup.

Your actual app code keeps using Prisma. Only the test reset path uses `pg`.
