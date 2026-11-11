---
description: Every stackctl command and flag - start, stop, reset, service, show-config, exec, run, logs, infra and init - plus global options, taking over a session and where state is kept.
---

# CLI

`sctl` is a short alias of `stackctl`: `sctl run api seed` is `stackctl run api seed`.

```bash
stackctl                          # the terminal UI: pick services, run them
stackctl -s web -s api            # run these services, skipping the picker
stackctl --headless -s web        # no UI: stream logs to stdout
stackctl --mode test              # another mode: .env.test, its own session
stackctl stop                     # stop the mode's session
stackctl service restart -s api   # restart one service in the running session
stackctl run api seed             # one script, with api's environment
stackctl infra up                 # bring the infra up, then exit
```

Every command works from anywhere in the repo: the workspace is the nearest directory, at or
above the current one, that holds `stackctl.config.ts`. Without one, every command except
`init` fails with
`No stackctl.config.ts in <dir> or any directory above it`.

| Command                                        | What it does                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| [`start`](#stackctl-start)                     | Start a session. The default command.                     |
| [`stop`](#stackctl-stop)                       | Stop the mode's session.                                  |
| [`reset`](#stackctl-reset)                     | Stop it, then delete the mode's state.                    |
| [`service`](#stackctl-service)                 | Start, stop or restart services in a running session.     |
| [`show-config`](#stackctl-show-config)         | Print the resolved config as JSON.                        |
| [`exec`](#stackctl-exec-and-stackctl-run)      | Run a command with a service's environment.               |
| [`run`](#stackctl-exec-and-stackctl-run)       | Run a script with a service's environment.                |
| [`logs`](#stackctl-logs)                       | Print or follow the session's log.                        |
| [`infra`](#stackctl-infra)                     | Bring infra up, down, or run Compose on it.               |
| [`init`](#stackctl-init)                       | Set the project up.                                       |

## Global options

Accepted before or after any command.

| Option                  | What it does                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `-m, --mode <name>`     | The [mode](../guide/env.md#modes). Default: `STACKCTL_MODE`, else `test` in CI, else `development`. |
| `--workspace-dir <dir>` | The directory holding the config, to run against a workspace from outside it. No walk-up. |
| `-V, --version`         | Print the version.                                                                    |
| `-h, --help`            | Help for the command.                                                                 |

## `stackctl start`

Starts a session. `stackctl` with no command is `stackctl start`, so `stackctl -s web` and
`stackctl start -s web` are the same.

| Option                   | What it does                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `-s, --service <name>`   | A service to run, with its deps. Repeatable. Skips the picker.                       |
| `--last-answers`         | Skip the picker and reuse the selection it last saved.                               |
| `--ui`                   | The terminal UI. The default.                                                        |
| `--headless`             | No UI: stream the log to stdout. Needs `-s` or `--last-answers`.                     |
| `-d, --detach`           | For CI: a headless session that outlives the command. Needs `-s` or `--last-answers`. |
| `--wait-timeout <s>`     | How long `--detach` waits for the session to be ready. Default `300`.                |
| `--kill-others`          | Quit a session already running in this mode without asking.                          |
| `--log-dir <dir>`        | Where to write the session log. Default `node_modules/.stackctl/modes/<mode>/logs/`. |

### `--headless`

Runs in the foreground until the session is quit, printing every log line, date-stamped and
labelled, with the infra's progress among them:

```
2026-11-10 16:00:11 [stackctl] [INFO] mode development (default)
▶ infra (development): db, mail
  mail  ready (0.4s)
2026-11-10 16:00:11 [infra:db] schema is up to date
  db    ready (0.5s)
✔ infra ready (0.5s)
2026-11-10 16:00:11 [api] started
2026-11-10 16:00:12 [api] listening on http://localhost:3001
```

A startup failure is printed, and the session shuts down and exits `1`. Ctrl+C or a `SIGTERM`
shuts it down gracefully.

### `--detach`

```bash
stackctl --mode test start --detach -s web
```

Starts a headless session with no tie to the terminal, waits until the infra and every service
are healthy, prints one line and exits `0`, leaving the session running:

```
test session ready: pid 4242, control API on 14012, log /repo/node_modules/.stackctl/modes/test/logs/1794164978752-4242-1.log
```

- **Progress goes to stderr**, so `$(…)` captures that line alone.
- **On failure** it stops the session, prints the error and the log's last 50 lines, and exits
  `1` with nothing left running.
- **End it** with `stackctl stop` (same mode).
- **A session already running in the mode fails it**, unless `--kill-others` is passed.
- **It is refused for a coding agent outside CI**: a detached session would outlive the
  agent's task. See [the agent playbook](../ai/playbook.md#start-a-stack).

### Taking over a running session

A workspace runs one session per mode. Sessions in different modes run side by side. Starting
a second one in the **same** mode means quitting the first, with every process under it:

| Situation                                    | What happens                            |
| -------------------------------------------- | --------------------------------------- |
| `--kill-others` passed                       | Quits the running session               |
| Both sessions were started by a coding agent | Quits it                                |
| A terminal is attached                       | Asks you to confirm                     |
| No terminal to ask in                        | Refuses, exits `1`, leaves it running   |

An agent can replace a session another agent started, never one you started. stackctl spots
an agent by the environment variables agents set (`CLAUDECODE`, `CURSOR_AGENT`, `GEMINI_CLI`,
`CODEX_SANDBOX`, `AGENT`, …). Set `STACKCTL_STARTED_BY_AGENT=0` or `=1` to override the
detection.

A recorded session whose process is alive but doesn't answer its control API looks hung, and
starting another in its mode is refused. `--kill-others` kills it, once it has confirmed the
process really is that session.

## `stackctl stop`

```bash
stackctl stop                # the session of the resolved mode
stackctl --mode test stop
```

Asks the mode's session to quit and waits for its services to stop. A session that doesn't
exit in time is force-killed with its process tree. Exits `0` when there was nothing to stop
(`No <mode> stackctl session is running.`), and `1` if the session is still running.

Other modes' sessions and [infra](../config/infra.md) are never touched.

`stop` only signals a process it can confirm is the recorded session. When it can't, it says
so and names the record: `node_modules/.stackctl/modes/<mode>/running.json`. Delete that file
by hand if no session is running.

## `stackctl reset`

```bash
stackctl --mode development reset
```

Runs `stop`, then deletes the mode's state, `node_modules/.stackctl/modes/<mode>/`: its
session record, saved selection and default logs. `--mode` is required. Infra, other modes
and logs written to a custom `--log-dir` are left alone.

## `stackctl service`

```bash
stackctl service restart -s api              # restart api, wait until it is ready
stackctl service start -s worker -s web      # start them, adding any the session lacks
stackctl --mode test service stop -s worker
```

Drives application services in the mode's **running** session, through its
[control API](./control-api.md). It never starts a session: with none running it exits `1`.

| Subcommand | What it does                                                                     |
| ---------- | -------------------------------------------------------------------------------- |
| `start`    | Starts each service, adding one the session was started without.                 |
| `stop`     | Stops each service. Services that wait on it keep running.                       |
| `restart`  | Restarts each service, starting a stopped one.                                   |

All take `-s, --service <name>`, repeatable. `start` and `restart` wait until the services
are ready, up to `--wait-timeout <s>` (default `300`), and exit `1` if one isn't. For infra
services, use [`stackctl infra`](#stackctl-infra).

## `stackctl show-config`

```bash
stackctl show-config
stackctl show-config --mode test
stackctl show-config | jq '.services | map_values({ port, publicOrigin })'
stackctl show-config | jq '.envFiles.workspace'
```

Prints the fully resolved config as JSON, with no session: callbacks have run and defaults
are applied. It is the same object a session reports as `config` on
[`GET /query/status`](./control-api.md#get-querystatus).

| Field           | What it holds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `services`      | Each service's `port`, `publicOrigin`, `urls`, `healthcheck`, `deps`, `command`, `relativeDir` and `absoluteDir`. |
| `infra`         | Per provider: the compose `file`, the mode's `projectName`, and each service's `enabled`, `port`, `urls` and `publicOrigin`. |
| `reverseProxy`  | Its `port`, `tls`, `publicAddress` and `routes`.                                       |
| `envFiles`      | The `.env` files the mode looks for, in load order, at the `workspace` and `service` scopes. |

Functions (`logs.formatter`, infra callbacks) have no JSON form and are left out.

## `stackctl exec` and `stackctl run`

```bash
stackctl exec [target] -- <command> [args...]
stackctl run [target] <script> [-- args...]
```

Run one command, or one `package.json` script or Makefile target, in a target's directory
with its environment. The [One-off commands](../guide/commands.md) guide covers targets.

| Option            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `--log-dir <dir>` | Where to write the call's log file.                       |

- **`exec` needs the `--`.** Everything after it is the command.
- **`run` forwards what follows `--`** to the script. A script that doesn't exist is an error.
- **`-s` is not accepted.** The target is the first argument.
- **The exit code is the command's.**

## `stackctl logs`

```bash
stackctl logs          # print the session's log file
stackctl logs -f       # print it, then follow
stackctl logs --path   # print its path
```

| Option         | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `-f, --follow` | Stream new lines until Ctrl+C. The session keeps running.            |
| `--path`       | Print the log file's path instead of its contents.                   |

Read-only: it never starts or stops anything. It finds the log by asking the running session,
else from the mode's session record, else the newest file in the mode's log directory.

## `stackctl infra`

```bash
stackctl infra up [services...] [--reset]
stackctl infra down [services...]
stackctl infra destroy [services...]
stackctl infra docker-compose [args...]
```

Drives the [infra](../config/infra.md) the config declares. Every subcommand exits when it is
done, and none disturbs a running session.

| Subcommand                 | What it does                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `up [services...]`         | Starts the services (default: every enabled one), waits until each is ready, runs `afterReady`, exits `0`, or `1` if one failed. They keep running. |
| `up --reset`               | Destroys those services first, then starts them clean.                                |
| `down [services...]`       | Removes the containers. Data is kept.                                                 |
| `destroy [services...]`    | Removes the containers **and their data**. With no services named, the whole project. |
| `docker-compose [args...]` | Runs `docker compose <args>` on this project and mode, with your terminal.            |

```
▶ infra (development): db, redis
  redis  ready (0.4s)
[db] 2 migrations applied
  db     ready (3.1s)
✔ infra ready (3.1s)
```

`--mode` picks the mode's `.env` files and its Compose project. With the passthrough it must
come **before** `docker-compose`, because everything after that word is Compose's:

```bash
stackctl -m test infra docker-compose ps
stackctl infra docker-compose logs -f db
stackctl infra docker-compose exec db psql -U example
```

## `stackctl init`

```bash
stackctl init        # interactive
stackctl init -y     # accept the defaults
```

Creates `stackctl.config.ts` if there is none, adds it to the root `tsconfig.json`, and
installs the [agent skill](../ai/overview.md#the-skill) if you agree. Safe to run again.
`--workspace-dir <dir>` creates the config in that directory.

## State

Everything stackctl keeps is under `node_modules/.stackctl/`:

```
node_modules/.stackctl/
  tls/                  the proxy's self-signed certificates, shared by every mode
  modes/<mode>/
    running.json        the session record: pid, control-API port, log file
    selection.json      the selection --last-answers reuses
    trusted.pem         the NODE_EXTRA_CA_CERTS bundle
    logs/               session and one-off command logs
```

## Exit codes

| Code          | When                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `0`           | The session was quit normally, or the command succeeded.                    |
| `1`           | Startup failed, a takeover was refused, or a command couldn't do its job.   |
| the command's | `exec` and `run` exit with their command's code.                            |
| `130`, `143`  | `--detach` interrupted by Ctrl+C or `SIGTERM` while waiting.                |
