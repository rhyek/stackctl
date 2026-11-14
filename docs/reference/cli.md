---
description: Every stackctl command and flag - start, stop, wait, reset, service, status, events, show-config, exec, run, logs, infra and init - plus global options, taking over a session and where state is kept.
---

# CLI

`sctl` is a short alias of `stackctl`: `sctl run api seed` is `stackctl run api seed`.

```bash
stackctl                          # the terminal UI: pick services, run them
stackctl -s web -s api            # run these services, skipping the picker
stackctl --headless -s web        # no UI: stream logs to stdout
stackctl --profile test           # another profile: .env.test, its own session
stackctl stop                     # stop the profile's session
stackctl service restart -s api   # restart one service in the running session
stackctl run api seed             # one script, with api's environment
stackctl infra start              # start the infra, then exit
```

Every command works from anywhere in the repo: the workspace is the nearest directory, at or
above the current one, that holds `stackctl.config.ts`. Without one, every command except
`init` fails with
`No stackctl.config.ts in <dir> or any directory above it`.

| Command                                        | What it does                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| [`start`](#stackctl-start)                     | Start a session. The default command.                     |
| [`stop`](#stackctl-stop)                       | Stop the profile's session.                               |
| [`wait`](#stackctl-wait)                       | Wait until the profile's session is ready.                |
| [`reset`](#stackctl-reset)                     | Stop it, then delete the profile's state.                 |
| [`service`](#stackctl-service)                 | Start, stop or restart services in a running session.     |
| [`status`](#stackctl-status)                   | The session now, and the last commands that acted on it.  |
| [`events`](#stackctl-events)                   | Print or follow the session's event log.                  |
| [`show-config`](#stackctl-show-config)         | Print the resolved config as JSON.                        |
| [`exec`](#stackctl-exec-and-stackctl-run)      | Run a command with a service's environment.               |
| [`run`](#stackctl-exec-and-stackctl-run)       | Run a script with a service's environment.                |
| [`logs`](#stackctl-logs)                       | Print or follow the session's log.                        |
| [`infra`](#stackctl-infra)                     | Start, stop, reset or destroy infra, or run Compose on it. |
| [`init`](#stackctl-init)                       | Set the project up.                                       |

## Global options

Accepted before or after any command.

| Option                  | What it does                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `-p, --profile <name>`  | The [profile](../guide/env.md#profiles). Default: `STACKCTL_PROFILE`, else `test` in CI, else `development`. A coding agent must name it. |
| `--workspace-dir <dir>` | The directory holding the config, to run against a workspace from outside it. No walk-up. |
| `-V, --version`         | Print the version.                                                                    |
| `-h, --help`            | Help for the command.                                                                 |

- **A coding agent names the profile on every command**, `development` included, with
  `--profile` or `STACKCTL_PROFILE`. A command it runs in the default profile, or CI's, exits
  `1` and says how to name it. `init`, `--help` and `--version` need no profile, and neither
  does the session [`startStack()`](./sdk.md#startstack) starts.

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
| `--kill-others`          | Quit a session already running in this profile without asking.                       |

It first [type-checks the config](../config/config-file.md#type-checking), and exits on a type
error.

The first time a person starts a session in a terminal, stackctl offers to install the
[agent guidance](../ai/overview.md#agent-guidance). It asks once, and never asks an agent, a
script or CI.

### `--headless`

Runs in the foreground until the session is quit, printing every log line, date-stamped and
labelled, with the infra's progress among them:

```
2026-11-10 16:00:11 [stackctl] [INFO] profile development (default)
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
stackctl --profile test start --detach -s web
```

Starts a headless session with no tie to the terminal, waits until the infra and every service
are healthy, prints one line and exits `0`, leaving the session running:

```
test session ready: pid 4242, control API on 14012, log /repo/node_modules/.stackctl/profiles/test/sessions/1794164978752/logs.txt
```

- **Progress goes to stderr**, so `$(…)` captures that line alone.
- **On failure** it stops the session, prints the error and the log's last 50 lines, and exits
  `1` with nothing left running.
- **End it** with `stackctl stop` (same profile).
- **A session already running in the profile fails it**, unless `--kill-others` is passed.
- **It is refused for a coding agent outside CI**: a detached session would outlive the
  agent's task. See [the agent playbook](../ai/playbook.md#start-a-stack).

### Taking over a running session

A workspace runs one session per profile. Sessions in different profiles run side by side.
Starting a second one in the **same** profile means quitting the first, with every process under
it:

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
starting another in its profile is refused. `--kill-others` kills it, once it has confirmed the
process really is that session.

## `stackctl stop`

```bash
stackctl stop                # the session of the resolved profile
stackctl --profile test stop
```

Asks the profile's session to quit and waits for its services to stop. A session that doesn't
exit in time is force-killed with its process tree. Exits `0` when there was nothing to stop
(`No <profile> stackctl session is running.`), and `1` if the session is still running.

Other profiles' sessions and [infra](../config/infra.md) are never touched.

`stop` only signals a process it can confirm is the recorded session. When it can't, it says
so and names the record: `node_modules/.stackctl/profiles/<profile>/running.json`. Delete that
file by hand if no session is running.

## `stackctl wait`

```bash
stackctl --profile test --headless -s api   # in a background task
stackctl --profile test wait                 # returns once it is ready
stackctl --profile test run api test
stackctl --profile test stop
```

Waits for the profile's session to start, then until its services and the infra are up and
healthy, as [`startStack()`](./sdk.md#startstack) waits. Prints the session's pid, control API
port and log, and exits `0`.

| Option                | What it does                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `--timeout <seconds>` | How long to wait, from the start to ready. Default `300`.            |

- **Exits `1` with the reason** when a service stops while starting, the session ends, or the
  timeout passes. With no session by then, it says none started.
- **A service with `autostart: false`** isn't waited on, since it stays stopped.
- **Read-only:** it never starts or stops anything.

## `stackctl reset`

```bash
stackctl --profile development reset
```

Runs `stop`, then deletes the profile's state, `node_modules/.stackctl/profiles/<profile>/`: its
session record, saved selection and every session's folder. `--profile` is required. Infra and
other profiles are left alone. The reset writes its own lines to a new event log.

## `stackctl service`

```bash
stackctl service restart -s api              # restart api, wait until it is ready
stackctl service start -s worker -s web      # start them, adding any the session lacks
stackctl --profile test service stop -s worker
```

Drives application services in the profile's **running** session, through its
[control API](./control-api.md). It never starts a session: with none running it exits `1`.

| Subcommand | What it does                                                                     |
| ---------- | -------------------------------------------------------------------------------- |
| `start`    | Starts each service, adding one the session was started without.                 |
| `stop`     | Stops each service. Services that wait on it keep running.                       |
| `restart`  | Restarts each service, starting a stopped one.                                   |

A service waiting for its dependencies is left to start once they're ready: `start` and
`restart` refuse it and exit `1`.

All take `-s, --service <name>`, repeatable. `start` and `restart` wait until the services
are ready, up to `--wait-timeout <s>` (default `300`), and exit `1` if one isn't. For infra
services, use [`stackctl infra`](#stackctl-infra).

## `stackctl status`

```bash
stackctl status          # the profile's session, and what last acted on it
stackctl status --json   # the same, as JSON
```

```
development session: running since today 13:21:57 (pid 86046, control port 14037), started by a person
services  backend   running, not ready
          frontend  running, not ready
          worker    running, ready
infra     db        running
          mail      running
log       node_modules/.stackctl/profiles/development/sessions/1794424917144/logs.txt
events    node_modules/.stackctl/profiles/development/sessions/1794424917144/events.jsonl

last commands
  today 13:21:57  session-start  backend, frontend, worker, headless
  today 13:21:57  infra-command  start every service                  ok, 646ms  by the session
  today 13:22:12  infra-command  restart db                           ok, 2.2s   by cli: infra restart -s db (a person)
```

- **The session** is the profile's running one, checked as
  [Finding the port](./control-api.md#finding-the-port) does. Without one it says so.
- **The last commands** are the last 10 commands and lifecycle entries of the session's event log,
  or the latest session's, each command's two lines as one row. See [Events](./events.md).
- **Read-only, and exits `0`** with a session or without.

## `stackctl events`

```bash
stackctl events          # the session's event log, one JSON object per line
stackctl events -n 20    # its last 20 lines
stackctl events -f       # print them, then follow
stackctl events --path   # print its path
```

The lines are [the event log's](./events.md), as they are in the file, for `jq`: the running
session's, else the latest one's. It never asks the session anything.

- **`-f` stops when the next session starts**, exiting `0` with a note on stderr: run it again to
  follow that one.

## `stackctl show-config`

```bash
stackctl show-config
stackctl show-config --profile test
stackctl show-config | jq '.services | map_values({ port, publicOrigin })'
stackctl show-config | jq '.envFiles.workspace'
```

Prints the fully resolved config as JSON, with no session: callbacks have run and defaults
are applied. It is the same object a session reports as `config` on
[`GET /query/status`](./control-api.md#get-querystatus).

| Field           | What it holds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `services`      | Each service's `port`, `publicOrigin`, `urls`, `healthcheck`, `deps`, `command`, `relativeDir` and `absoluteDir`. |
| `infra`         | Per provider: the compose `file`, the profile's `projectName`, and each service's `enabled`, `port`, `urls` and `publicOrigin`. |
| `reverseProxy`  | Its `port`, `tls`, `publicAddress` and `routes`.                                       |
| `envFiles`      | The `.env` files the profile looks for, in load order, at the `workspace` and `service` scopes. |

Functions (`logs.formatter`, infra callbacks) have no JSON form and are left out.

## `stackctl exec` and `stackctl run`

```bash
stackctl exec [target] -- <command> [args...]
stackctl run [target] <script> [-- args...]
```

Run one command, or one `package.json` script or Makefile target, in a target's directory
with its environment. The [One-off commands](../guide/commands.md) guide covers targets. Its log
goes in the latest session's folder, under `commands/`.

- **`exec` needs the `--`.** Everything after it is the command.
- **`run` forwards what follows `--`** to the script. A script that doesn't exist is an error.
- **`run` first [type-checks the config](../config/config-file.md#type-checking)**, and exits on
  a type error. `exec` doesn't.
- **`-s` is not accepted.** The target is the first argument.
- **The exit code is the command's.**
- **On a terminal, the command gets it**, stdout and stderr each on its own, except for a coding
  agent, whose command is always piped. Its log then holds no output for that stream.

## `stackctl logs`

```bash
stackctl logs          # print the session's log file
stackctl logs -f       # print it, then follow
stackctl logs --path   # print its path
```

| Option         | What it does                                                         |
| -------------- | -------------------------------------------------------------------- |
| `-f, --follow` | Stream new lines until Ctrl+C or the next session starts.            |
| `--path`       | Print the log file's path instead of its contents.                   |

Read-only: it never starts or stops anything. It shows the running session's log, else the
latest session's. A one-off command's log is never it.

## `stackctl infra`

```bash
stackctl infra start   [-s <name>...]
stackctl infra stop    [-s <name>...]
stackctl infra restart [-s <name>...]
stackctl infra reset   [-s <name>...]
stackctl infra destroy [-s <name>...]
stackctl infra docker-compose [args...]
```

Drives the [infra](../config/infra.md) the config declares, the same actions as a session's
`s`, `r` and `R` keys. Every subcommand exits when it is done, and none disturbs a running
session.

| Subcommand                 | What it does                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `start`                    | Starts the services, waits until each is ready and runs `afterReady`, then exits `0`, or `1` if one failed. They keep running. |
| `stop`                     | Removes the containers. Data is kept.                                                 |
| `restart`                  | `stop`, then `start`: the containers are recreated, picking up a changed compose file. Data is kept. |
| `reset`                    | Removes the services **and their data**, then starts them clean.                      |
| `destroy`                  | Removes the containers **and their data**, and starts nothing. With no `-s`, the whole project. |
| `docker-compose [args...]` | Runs `docker compose <args>` on this project and profile, with your terminal.         |

- **`-s, --service <name>` picks the services**, repeatable. With none, every enabled one:
  `stackctl infra reset` deletes **every** infra service's data.
- **`start` runs `afterReady` even for a service already running**, so it applies new
  migrations to a database that is up.
- **`reset` here is not `stackctl reset`**, which deletes the profile's session state and leaves
  infra alone.

```
▶ infra (development): db, redis
  redis  ready (0.4s)
[db] 2 migrations applied
  db     ready (3.1s)
✔ infra ready (3.1s)
```

`--profile` picks the profile's `.env` files and its Compose project. With the passthrough it
must come **before** `docker-compose`, because everything after that word is Compose's:

```bash
stackctl -p test infra docker-compose ps
stackctl infra docker-compose logs -f db
stackctl infra docker-compose exec db psql -U example
```

## `stackctl init`

```bash
stackctl init        # interactive
stackctl init -y     # accept the defaults
```

Creates `stackctl.config.ts` if there is none, adds it to the root `tsconfig.json`, and offers
the [agent guidance](../ai/overview.md#agent-guidance). Safe to run again.

| Flag                    | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `-y`, `--yes`           | No questions: the config, and the rules file and the skill.          |
| `--agents-md`           | Also adds a stackctl section to `AGENTS.md`.                         |
| `--workspace-dir <dir>` | Creates the config in that directory.                                |

What the agent guidance is, on disk:

| File                               | Read by                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `.claude/rules/stackctl.md`        | Claude Code, at the start of every session.                    |
| `.claude/skills/stackctl/SKILL.md` | Agents that load skills. Also under `.agents/` and `.cursor/` when those exist. |
| A section of `AGENTS.md`           | Agents that read that file: Codex, Cursor, Copilot. Only with `--agents-md`. |

- **The rules file and the skill are stackctl's own**: a copy you edited is left alone, and
  `init` rewrites it.
- **The `AGENTS.md` section sits between two markers**, `<!-- BEGIN:stackctl -->` and
  `<!-- END:stackctl -->`, in a new file if there is none. Everything outside them is yours.
- **Claude Code reads `AGENTS.md` only in a repo with no `CLAUDE.md`**, which is why it gets a
  rules file of its own.
- **pnpm can link the skill itself.** The package ships it in `skills/`, where `pnpm approve`
  finds it (pnpm 12.11 and later). Where pnpm's link is there, stackctl keeps no copy of the
  skill.

## State

Everything stackctl keeps is under `node_modules/.stackctl/`:

```
node_modules/.stackctl/
  tls/                  the proxy's self-signed certificates, shared by every profile
  profiles/<profile>/
    running.json        the session record: pid, control-API port, log file
    selection.json      the selection --last-answers reuses
    trusted.pem         the NODE_EXTRA_CA_CERTS bundle
    sessions/<id>/      one per session, named by its start, kept 7 days
      logs.txt          the session's log
      events.jsonl      what acted on the stack (see Events)
      commands/         the logs of exec and run
```

## Exit codes

| Code          | When                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `0`           | The session was quit normally, or the command succeeded.                    |
| `1`           | Startup failed, a takeover was refused, or a command couldn't do its job.   |
| the command's | `exec` and `run` exit with their command's code.                            |
| `130`, `143`  | `--detach` interrupted by Ctrl+C or `SIGTERM` while waiting.                |
