---
description: Give an e2e suite or a CI job a healthy stack with startStack(), stackctl start --detach or --headless, in a test profile that runs beside your dev session.
---

# Tests and CI

An e2e suite needs the same stack you develop against: started, healthy, and gone when the
suite ends. stackctl gives it one in a single call, in a profile of its own so it never touches
the session you are working in.

## A test profile

Create `.env.test` next to `.env.development`, with **different ports**:

```sh
# .env.test
API_PORT=21060
DB_PORT=21061
```

`--profile test` then runs a second, separate session: its own processes, its own
[infra containers](../config/infra.md#profiles) and database, its own state. See
[Profiles](./env.md#profiles).

## In a test runner

Call `startStack()` from the suite's global setup. It starts a headless session and resolves
once the infra and every service are healthy:

```ts
import { startStack } from 'stackctl';

// in the global setup
const stack = await startStack({ profile: 'test', services: ['web'] });
// hand stack.origins.web to the specs

// in the global teardown
await stack.stop();
```

- **The session ends with the process that started it**, however that ends: `stop()`, a runner
  that exits, a `kill -9`. Nothing is left running.
- **It fails rather than share.** If a `test` session is already running, the call rejects,
  naming its pid. Pass `killOthers: true` to replace it.
- **On failure it rejects** with the reason and the log's path, after stopping the session:
  `not healthy after 300s: worker`.

`stack.origins` has every service's URL, and `stack.control` is a
[control API](../reference/control-api.md) client for restarting a service mid-suite. See
[`startStack()`](../reference/sdk.md#startstack).

## In CI

`stackctl start --detach` starts the stack, waits until it is healthy, prints one line and
exits, leaving the session running for the next steps:

```yaml
- run: pnpm stackctl start --detach -s web
- run: pnpm test:e2e
- if: always()
  run: pnpm stackctl stop
```

In CI the profile defaults to `test`, so both commands act on the test session. If the stack
doesn't come up, `--detach` stops it, prints the error and the log's last 50 lines, and exits
`1`. See [`stackctl start`](../reference/cli.md#stackctl-start).

A suite that calls `startStack()` itself needs neither step.

## From a shell script

`--headless` runs a session in the foreground with no UI, streaming its log to stdout. Wait
for it with [`stackctl wait`](../reference/cli.md#stackctl-wait):

```sh
stackctl --profile test --headless -s web &
session=$!
trap 'kill $session 2>/dev/null' EXIT   # SIGTERM shuts it down gracefully

stackctl --profile test wait || exit 1
pnpm test:e2e
```

## One-off test commands

For a suite that needs the environment but not the services, run it through
[`sctl run`](./commands.md):

```bash
sctl --profile test run api test
```
