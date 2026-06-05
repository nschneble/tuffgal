# Supervisor

`tuffgal supervise` is a long-running wrapper around your
`devServers.command`. It exists for one specific situation: a developer
iterating heavily on stories with an always-on dev server running in the
background.

## What it does

**Spawns `devServers.command` in a detached process group.** Combined
output is tied to `<paths.report>/dev-servers.log`. The process group means
SIGTERM hits every child, not just the shell wrapper.

**Periodically probes every `devServers.healthCheck` url.** Uses TCP
`connect`, not HTTPm so self-signed certs and 404s don't trip the probe.

**Respawns the tree when a probe fails or the wrapper exits unexpectedly.**
Up to `--max-respawns` times. Stops cleanly once the budget is exhausted.

**Self-terminates after a wall-clock cap.** Defaults to 60 minutes using
`--max-runtime`, so a forgotten supervisor session doesn't run forever.

**Self-terminates after an idle window.** Defaults to 10 minutes using
`--idle-limit`, where no `tuffgal run` has touched
`<paths.report>/.heartbeat`. Every `tuffgal run` writes an ISO timestamp,
so the supervisor knows whether anyone is still iterating.

**Handles SIGINT and SIGTERM.** Tears down the whole detached tree.
SIGTERM → grace window → SIGKILL.

## When to use it

Use the supervisor when you're authoring stories interactively over hours
and want the dev servers to stay healthy without manual restarts. Skip it
for CI. CI runs are one-shot and should use `tuffgal run --manage-servers`
instead, which spawns the servers, waits for them, runs once, then tears
them down.

## Usage

```bash
# defaults: 30s probe, 10min idle, 60min cap, 3 respawns
npx tuffgal supervise

# override any subset
npx tuffgal supervise --healthcheck-interval 60000 --idle-limit 1800000
```

Environment variables work too! CLI flags win over env vars.

| Variable                          | Default | Meaning                                      |
| --------------------------------- | ------- | -------------------------------------------- |
| `TUFFGAL_HEALTHCHECK_INTERVAL_MS` | 30000   | Probe interval                               |
| `TUFFGAL_IDLE_LIMIT_MS`           | 600000  | Window with no `tuffgal run` heartbeat       |
| `TUFFGAL_MAX_RESPAWNS`            | 3       | Respawn budget after unhealthy or early exit |
| `TUFFGAL_MAX_RUNTIME_MS`          | 3600000 | Wall-clock cap                               |

## Heartbeat

`tuffgal run` writes an ISO timestamp to `<paths.report>/.heartbeat` at the
start of every invocation. The supervisor reads its `mtime` on each probe.
If `now - mtime > idleLimitMs`, the supervisor exits.

A missing heartbeat file is treated as "no runs yet" rather than stale, so
a fresh supervisor in a fresh shell does not immediately kill itself before
the user runs anything.

## Requirements

The supervisor requires a `devServers` block in `tuffgal.config.ts`:

```ts
export default defineConfig({
  // …
  devServers: {
    command: 'npm run dev:test',
    healthCheck: [
      { url: 'http://localhost:3000' },
      { url: 'http://localhost:5173' },
    ],
  },
});
```

Without it, `tuffgal supervise` fails fast with a descriptive error.

## Programmatic use

```ts
import { loadConfig, supervise } from 'tuffgal';

const config = await loadConfig(process.cwd());
await supervise(config, { idleLimitMs: 30 * 60_000 });
```

`supervise` returns when the supervisor self-terminates either from cap,
idle timeout, or exhausted budget. It calls `process.exit(0)` on a
signal-driven teardown, so don't rely on the returned promise for the
SIGINT/SIGTERM path.
