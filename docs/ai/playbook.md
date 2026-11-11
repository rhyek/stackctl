---
description: Recipes for a coding agent - check whether an app is running, find a service's URL, start a stack in the background and wait for it, restart a service, run one-off commands, use infra, read logs and onboard a new service.
---

# Agent playbook

Recipes for a coding agent working in a repo that uses stackctl. Each one links to the
reference page with the details.

## Rules

- **Never `kill`, `pkill` or `lsof … | kill` a stackctl process or its port.** Stop a session
  with `POST /command/quit` or `stackctl stop`, and restart a service with
  `stackctl service restart -s <name>`. A killed session leaves its services running.
- **Check before you start anything.** Starting a session in a mode quits the one already
  running in it. stackctl refuses that when a person started it.
- **Never guess a port or hostname.** `stackctl show-config` prints the resolved ones.
- **Don't pass `--kill-others` or `killOthers: true`** unless the user said to.
- **Don't use `stackctl start --detach`.** It is for CI and is refused for an agent.
- **`stackctl infra up --reset` and `stackctl infra destroy` delete data.** Only on request.
- **Use `stackctl infra docker-compose …`**, never a bare `docker compose …`, which talks to
  a different Compose project.
- **Write `stackctl`, never its alias `sctl`.** Guide pages type `sctl`; permission rules and
  scripts match the full name.

## Is it running?

1. **Is the repo managed by stackctl?** Look for `stackctl.config.ts` at or above the app's
   directory. If there is none, see [Apps stackctl doesn't manage](#apps-stackctl-doesnt-manage).
2. **Is the app one of its services?** `stackctl show-config | jq '.services | keys'`. The key
   is the name `-s` and the control API take. It need not match the directory.
3. **Is a session live?** Read the mode's record and check it, as in
   [Finding the port](../reference/control-api.md#finding-the-port). No record, or a dead
   pid, means no session.
4. **Read the service's state** from `GET /query/status`:

```bash
curl -s "http://127.0.0.1:$port/query/status" | jq '{ services, ready, sessionReady }'
```

| `services.<name>` | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `running`         | Its process is live. `ready.<name>` says whether it passes its healthcheck. |
| `waiting`         | Held back by a service it waits for.                                       |
| `restarting`      | On its way back up.                                                        |
| `stopped`         | Not running: it exited, crashed or was never started.                      |
| not a key         | Configured, but not part of this session.                                  |

`services: null` means the session is still starting its infra. Check again in a few seconds.

## Reach a service

```bash
stackctl show-config | jq '.services | map_values({ port, publicOrigin, healthcheck })'
```

No session is needed. Pass the `--mode` the session runs in.

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
stackctl --headless -s web
```

1. **Run it with your harness's background-task tool**, so the session ends when the task or
   your conversation does. Never with `&`, `nohup` or `setsid`.
2. **Find its port** in `node_modules/.stackctl/modes/<mode>/running.json`, which appears as
   soon as the session starts.
3. **Wait until it is healthy** on the event stream:

```bash
curl -sN "http://127.0.0.1:$port/events" \
  | grep -m1 -E '"sessionReady":true|"type":"session","ready":true|"status":"stopped"'
```

   A line with `"status":"stopped"` means a service crashed while starting. Read the log.
4. **Stop it** when done: `POST /command/quit`, or stop the background task.

The config's infra comes up first on its own, and stays up after the session ends. For an
e2e suite, call [`startStack()`](../guide/testing.md#in-a-test-runner) from its global setup
instead. For a CI workflow you are asked to write, use
[`stackctl start --detach`](../guide/testing.md#in-ci).

## Drive a running session

From a shell, in the session's mode:

```bash
stackctl service restart -s api   # waits until it is ready again
stackctl service stop -s worker
stackctl service start -s worker  # also adds a service the session was started without
```

Or over the [control API](../reference/control-api.md):
`POST /command/service/<start|stop|restart>/<name>`.

`stackctl stop` ends the whole session, including one a person started. Run it only when
asked.

## After editing code

Read the service's `command` in `stackctl show-config`:

| `command.watches` | After an edit to its code                  |
| ----------------- | ------------------------------------------ |
| `true`            | Nothing. Its dev script reloads itself.    |
| `false`           | `stackctl service restart -s <name>`       |

An edit to a `.env` file restarts the affected services on its own, so an unexpected restart
may be an env edit, not a crash. An edit to `stackctl.config.ts` needs the session restarted.

## Run a one-off command

Use the service's own environment. Don't export variables by hand.

```bash
stackctl run api seed                          # a package.json script or Makefile target
stackctl exec api -- node src/migrate.ts       # any command
stackctl --mode test exec api -- node --test   # in the test mode's environment
```

See [One-off commands](../guide/commands.md). From a script, use
[`exec()`, `run()`](../reference/sdk.md#exec-and-run) or
[`resolveEnv()`](../reference/sdk.md#resolveenv).

## Infra

```bash
stackctl infra up                          # start the databases etc., wait until ready
stackctl infra docker-compose ps           # what is running
stackctl infra docker-compose exec db psql -U app
stackctl infra docker-compose logs --tail 100 db
```

A session starts its infra itself. In a running session, restart one infra service with
`POST /command/infra/restart/<name>`. See [Infra](../config/infra.md).

## Read logs

```bash
stackctl logs                 # the current session's whole log
stackctl logs --path          # its path, to grep or tail
grep -i error "$(stackctl logs --path)"
```

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
5. **Check it:** `stackctl show-config | jq '.services["my-service"]'`.

## Apps stackctl doesn't manage

If the repo has no stackctl config, or the app isn't in `services`, say so. That is a
complete answer. Then check the app directly: find the port it binds, and

```bash
lsof -nP -iTCP:$PORT -sTCP:LISTEN
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 2 "http://localhost:$PORT/"
```

A service stackctl manages can also be running outside it, started by hand. `/query/status`
can't see that, the port check can. Report what you find, and never kill it.
