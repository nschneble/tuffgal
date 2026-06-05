# The app contract

Tuffgal sits between a human authoring stories in JSON and a real running
app. For visual regression to mean a damn thing, the app under the
microscope must behave deterministically when Tuffgal is driving it. This
document describes the test-mode contract your app should implement.

## The single switch

Pick an environment variable and let it flip your app into deterministic
mode. The conventional name is `TUFFGAL=1`, but any name works. Get weird
with it.

```bash
TUFFGAL=1 npm run dev
```

This env var becomes a single audit point. Anything sensitive to it shows
up in `git grep TUFFGAL`. Treat it as the bright line between production
and harness modes. Or like the Eye of Sauron.

## What the contract should cover

Five things, ordered by how often they bite.

### 1. Bypass rate limiters

Production limiters per IP, per user, or per route assume real human
pacing. The harness hammers the same routes across many stories within a
few seconds. Rate-limited endpoints become flaky stories REAL FAST.

```ts
// NestJS throttler bypass from linklater/apps/api
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected override shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(process.env.TUFFGAL === '1');
  }
}
```

Express + `express-rate-limit`:

```ts
app.use(
  rateLimit({
    skip: () => process.env.TUFFGAL === '1',
    // ...
  }),
);
```

### 2. Skip background jobs

RSS feed pollers, email workers, scheduled-report cron jobs,
queue consumers, and analytics flushers all introduce non-determinism. They
write to the same database the harness is documenting. Disable them
entirely under `TUFFGAL`.

```ts
@Injectable()
export class FeedRefreshService implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    if (process.env.TUFFGAL === '1') {
      this.logger.log('TUFFGAL=1: skipping feed refresh scheduling');
      return;
    }
    this.scheduleRefresh();
  }
}
```

### 3. No-op external side effects

We're getting into mock territory here. You should replace email, SMS,
payment captures, webhook deliveries, third-party analytics, and push
notifications with logged no-ops. This keeps the harness from sending real
emails (or charging real credit cards) every time you run it.

```ts
async send(options: EmailOptions): Promise<void> {
  if (process.env.TUFFGAL === '1') {
    this.logger.log(
      `TUFFGAL=1: noop email to="${String(options.to)}", subject="${String(options.subject)}"`,
    );
    return;
  }
  await this.realProvider.send(options);
}
```

### 4. Deterministic fixtures for third-party reads

Calls _out_ of your app to third parties (weather APIs, social embeds,
OG-tag scrapers, geolocation lookups) subsequently return different data.
Wrap each external call site behind a service interface and swap to a
deterministic fixture under `TUFFGAL`.

```ts
@Injectable()
export class GeolocationService {
  async lookup(ip: string): Promise<Coordinates> {
    if (process.env.TUFFGAL === '1') {
      return { latitude: 40.6782, longitude: -73.9442 };
    }
    return this.realProvider.lookup(ip);
  }
}
```

Tuffgal also offers an `intercept` step primitive that stubs requests at
the browser layer. Use intercept when the call originates in browser code;
use the app-side fixture when the call originates in your back-end.

### 5. Pin the clock (optional)

Tuffgal's `frozenTime` config field freezes `Date.now()` inside the browser
via `page.clock.install`. The server still sees real time. This is fine for
most apps because rendered relative timestamps (e.g. `3 minutes ago`) are
typically computed client-side.

If your back-end persists timestamps that show up in screenshots (audit
logs, last-login banners), consider pinning the server clock too:

```ts
const now = (): Date =>
  process.env.TUFFGAL === '1' ? new Date('2026-06-01T12:00:00Z') : new Date();
```

Then route every `new Date()` in render paths through `now()` and match the
value to your config's `frozenTime` so server-rendered and client-rendered
timestamps always agree.

## What the contract shouldn't cover

Don't use `TUFFGAL` to hide bugs from the harness. I mean, why bother? The
point of visual regression is to catch what's changed. If you find yourself
adding `if (TUFFGAL) return earlier;` to skip a path the harness is failing
on, the harness is doing its job and you are failing at yours. Fix it.

The contract is for **inputs the harness cannot control** (real time, real
third parties, real send-side-effects) and not for masking flaky output.

## A test-mode dev server script

Most consumers wire test mode into a dedicated `dev:test` npm script that
the Tuffgal dev server bridge spawns. Set the env var there so you never
forget it:

```json
{
  "scripts": {
    "dev": "npm run dev --workspaces",
    "dev:test": "TUFFGAL=1 npm run dev --workspaces"
  }
}
```

Then in your `tuffgal.config.ts`:

```ts
devServers: {
  command: 'npm run dev:test',
  healthCheck: [/* ... */],
}
```

When using `tuffgal run --manage-servers` or `tuffgal supervise`, the
harness spawns `npm run dev:test` and the `TUFFGAL=1` flag is set
automatically for every back-end process. Manual `npm run dev:test`
invocations get the same flag.

## Audit checklist

Review this list before publishing your first stable baseline. Each item
that fails the audit can cause intermittent visual diffs.

- [ ] Rate limiters bypassed under TUFFGAL
- [ ] Background jobs and schedulers skipped under TUFFGAL
- [ ] Email and external write side effects no-op'd under TUFFGAL
- [ ] Third-party reads return deterministic fixtures under TUFFGAL
- [ ] Server-rendered timestamps pin to a known instant (if your screenshots include them)
- [ ] `dev:test` script sets TUFFGAL=1 unconditionally
- [ ] `git grep TUFFGAL` returns a list of guard sites you recognize
