---
description: Recipes for a coding agent - check whether an app is running, find a service's URL, start a stack in the background and wait for it, run tests in the test mode, restart a service, bring back one that is down, run one-off commands, use infra, read logs and onboard a new service.
---

# Agent playbook

Recipes for a coding agent working in a repo that uses stackctl. Each one links to the
reference page with the details.

## Rules

- **Run stackctl through the package manager:** `pnpm stackctl …` (or `npx`, `yarn`, `bunx`).
  It is a dev dependency, not on your `PATH`. The recipes here write `stackctl` for short.
- **Name the mode on every command, `development` included:** `stackctl --mode development
  status`, `stackctl --mode test run api test`. Each mode is a session of its own, with its own
  ports and database: `development` is the one the person works in, `test` the one tests run
  in. stackctl refuses an agent's command that leaves the mode to the default.
- **Never `kill`, `pkill` or `lsof … | kill` a stackctl process or its port.** Stop a session
  you started with `stackctl --mode <mode> stop`, and restart a service with
  `stackctl --mode <mode> service restart -s <name>`. A killed session leaves its services
  running.
- **Check before you start anything.** Starting a session in a mode quits the one already
  running in it. stackctl refuses that when a person started it.
- **Never guess a port or hostname.** `stackctl --mode <mode> show-config` prints the resolved
  ones.
- **Don't pass `--kill-others` or `killOthers: true`** unless the user said to.
- **Don't use `stackctl start --detach`.** It is for CI and is refused for an agent.
- **`stackctl infra reset` and `stackctl infra destroy` delete data.** Only on request.
- **Use `stackctl infra docker-compose …`**, never a bare `docker compose …`, which talks to
  a different Compose project.
- **Write `stackctl`, never its alias `sctl`.** Guide pages type `sctl`; permission rules and
  scripts match the full name.

## Is it running?

1. **Is the repo managed by stackctl?** Look for `stackctl.config.ts` at or above the app's
   directory. If there is none, see [Apps stackctl doesn't manage](#apps-stackctl-doesnt-manage).
2. **Is the app one of its services?** `stackctl --mode development show-config | jq '.services
   | keys'`. The key is the name `-s` and the control API take. It need not match the directory.
3. **Ask stackctl:** `stackctl --mode development status` says whether the mode's session runs,
   each service's state and readiness, and the last commands that acted on it. With `--json` it
   has the same for `jq`: `.status.services`, `.status.ready`. See
   [`stackctl status`](../reference/cli.md#stackctl-status).

| `services.<name>` | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `running`         | Its process is live. `ready.<name>` says whether it passes its healthcheck. |
| `waiting`         | Held back by a service it waits for.                                       |
| `restarting`      | On its way back up.                                                        |
| `stopped`         | Not running: it exited, crashed or was never started.                      |
| not a key         | Configured, but not part of this session.                                  |

No services yet means the session is still starting its infra. Check again in a few seconds.

## Reach a service

```bash
stackctl --mode development show-config \
  | jq '.services | map_values({ port, publicOrigin, healthcheck })'
```

No session is needed. Pass the mode of the session you will call: each mode has its own ports.

- **`publicOrigin`** is where a browser reaches the service, and the address the app itself is
  configured for. Through the [reverse proxy](../config/reverse-proxy.md), a service that is
  down answers `503` with its status, not a connection error.
- **`port`** is the service itself: `curl http://localhost:<port>/…`. It works in every setup,
  while the service runs.
- **`*.localhost` names resolve in browsers, not in `curl`.** Pass the host:
  `curl -H 'Host: api.localhost' http://127.0.0.1:<proxy port>/`.
- **Infra services** with a port are under `.infra["docker-compose"].services`.

## Start a stack

Only when no session is running in that mode. There is no TTY, so always pass `--headless`
and name the services:

```bash
stackctl --mode development --headless -s web
```

1. **Run it with your harness's background-task tool**, so the session ends when the task or
   your conversation does. Never with `&`, `nohup` or `setsid`.
2. **Wait until it is healthy:** `stackctl --mode development wait`. It exits `0` once the
   services and the infra are up, and `1` with the reason when a service stops while starting:
   read the log. See [`stackctl wait`](../reference/cli.md#stackctl-wait).
3. **Stop it** when done: `stackctl --mode development stop`, or stop the background task.

The config's infra comes up first on its own, and stays up after the session ends. For an
e2e suite, call [`startStack()`](../guide/testing.md#in-a-test-runner) from its global setup
instead. For a CI workflow you are asked to write, use
[`stackctl start --detach`](../guide/testing.md#in-ci).

## Run tests

Tests that call the services need them running, in the test mode: its own ports and its own
database, so a test never writes to the data you develop with.

1. **Find the test mode:** a `.env.test` beside `stackctl.config.ts`. Without one, ask.
2. **Start a test session** of the services the tests call, as in [Start a stack](#start-a-stack):
   `stackctl --mode test --headless -s api` in the background, then `stackctl --mode test wait`.
   It runs beside a development session when the services it starts have ports of their own in
   the test mode.
3. **Run the tests in its environment:** `stackctl --mode test run api test`.
4. **Stop it:** `stackctl --mode test stop`.

A suite that calls [`startStack()`](../guide/testing.md#in-a-test-runner) starts its own session:
just run it. Never run tests against the development session.

## Drive a running session

From a shell, in the session's mode:

```bash
stackctl --mode development service restart -s api   # waits until it is ready again
stackctl --mode development service stop -s worker
stackctl --mode development service start -s worker  # also adds one the session hasn't
```

Or over the [control API](../reference/control-api.md):
`POST /command/service/<start|stop|restart>/<name>`.

`stackctl --mode <mode> stop` ends the whole session, including one a person started. Run it
only on a session you started, or when asked.

## A service is down

1. **Read its state**, as in [Is it running?](#is-it-running): `stopped`, or `running` but
   not ready. A dev script that watches its files, such as `node --watch`, outlives its app:
   when the app exits it stays `running` and waits for an edit.
2. **Find why it stopped:** `stackctl --mode development logs | grep '\[api *\]' | grep -iE
   'error|exception'`. A crash prints its error first, then its stack and anything it dumps, so
   its last lines rarely say why.
3. **Find what acted on it.** The [event log](../reference/events.md) records every command that
   changed the stack, by a key, the control API or a stackctl command, and who ran it. `status`
   lists the last ones; `stackctl --mode development events -n 50` has the session's, with each
   service's state changes: an infra service restarted just before the crash is the likely cause.
4. **Restart it:** `stackctl --mode development service restart -s api` waits until it is ready
   again.
5. **Read its lines again**, to see it come up or why it failed again.

Don't run the service's command yourself while the session runs it: your copy takes its port.

## After editing code

Read the service's `command` in `stackctl --mode <mode> show-config`:

| `command.watches` | After an edit to its code                           |
| ----------------- | --------------------------------------------------- |
| `true`            | Nothing. Its dev script reloads itself.             |
| `false`           | `stackctl --mode <mode> service restart -s <name>`  |

An edit to a `.env` file restarts the affected services on its own, so an unexpected restart
may be an env edit, not a crash. An edit to `stackctl.config.ts` needs the session restarted.

## Run a one-off command

Use the service's own environment. Don't export variables by hand.

```bash
stackctl --mode development run api seed       # a package.json script or Makefile target
stackctl --mode development exec api -- node src/migrate.ts   # any command
stackctl --mode test exec api -- node --test   # in the test mode's environment
```

See [One-off commands](../guide/commands.md). From a script, use
[`exec()`, `run()`](../reference/sdk.md#exec-and-run) or
[`resolveEnv()`](../reference/sdk.md#resolveenv).

## Infra

```bash
stackctl --mode development infra start             # start the databases etc.
stackctl --mode development infra docker-compose ps  # what is running
stackctl --mode development infra docker-compose exec db psql -U app
stackctl --mode development infra docker-compose logs --tail 100 db
```

A session starts its infra itself. In a running session, restart one infra service with
`POST /command/infra/restart/<name>`. See [Infra](../config/infra.md).

## Read logs

```bash
stackctl --mode development logs          # the current session's whole log
stackctl --mode development logs | grep -i error
stackctl --mode development logs --path   # its path, to read or tail
```

Pipe `logs` rather than substituting `$(stackctl --mode development logs --path)`: a harness
can't check a command substitution before it runs, so it asks the user.

Each line is `<timestamp> [<service>] <text>`, the label padded with spaces before its `]` so
every line's text lines up: match one service's with `grep '\[api *\]'`. `[stackctl]` lines are
the session's own, `[control]` lines are commands received over the control API, and
`[infra:<name>]` lines are an infra service's. Earlier sessions' logs are kept beside the
current one. See [Logs](../guide/logs.md).

## Onboard a service

To add a service to stackctl:

1. **Give it a dev entry point.** A `dev` script in its `package.json`, or for a service
   without one, a `Makefile` target (recipe lines indented with a tab). If it already has an
   equivalent script under another name (`start:dev`, `serve`), rename it to `dev` and fix the
   references, or set `command`.
2. **Add a key to `services`** in `stackctl.config.ts`. The key is its name, and its directory
   is `<serviceRootDir>/<key>`:

```ts
'my-service': {
  port: 3001,
  healthcheck: '/health',
  deps: [{ service: 'other-service', wait: true }],
},
```

3. **Fill in what is true of it**, per [Services](../config/services.md):
   - `port`: the port it listens on. It reads it from `PORT`.
   - `healthcheck`: a path, if it has a health endpoint.
   - `deps`: the services it needs, with `wait: true` for one it can't start without.
   - `command: ['<script>', { watches: false }]` if its dev script doesn't reload on edits.
   - `urls: ['']` for something a person opens in a browser.
4. **Prefer paths to full URLs** (`'/health'`, `'/admin'`), and a callback only for a value
   that depends on the environment. Config strings are not interpolated.
5. **Check it:** `stackctl --mode development show-config | jq '.services["my-service"]'`.

## Apps stackctl doesn't manage

If the repo has no stackctl config, or the app isn't in `services`, say so. That is a
complete answer. Then check the app directly: find the port it binds, and

```bash
lsof -nP -iTCP:$PORT -sTCP:LISTEN
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 2 "http://localhost:$PORT/"
```

A service stackctl manages can also be running outside it, started by hand. `/query/status`
can't see that, the port check can. Report what you find, and never kill it.
