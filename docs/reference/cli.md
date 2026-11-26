---
description: Every stackctl command and flag - start, stop, wait, reset, service, status, events, show-config, exec, run, logs, infra and init - plus global options, taking over a session and where state is kept.
---

# CLI

`sctl` is a short alias of `stackctl`: `sctl run api seed` is `stackctl run api seed`.

```bash
stackctl                          # the terminal UI: pick services, run them
stackctl -s web -s api            # run these services, skipping the picker
stackctl -t backend               # every service tagged backend
stackctl --headless -s web        # no UI: stream logs to stdout
stackctl --profile test           # another profile: .env.test, its own session
stackctl stop                     # stop the profile's session
stackctl service restart -s api   # restart one service in the running session
stackctl run api seed             # one script, with api's environment
stackctl run -t backend test      # a script in every service tagged backend
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
| [`infra`](#stackctl-infra)                     | Start, stop, restart, reset or destroy infra, or run Compose on it. |
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

| Option                    | What it does                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `-s, --service <service>` | A service to run, with its deps. Repeatable. Skips the picker.                              |
| `-t, --tag <tag>`         | Every service with the tag, with their deps. Repeatable. Skips the picker.                  |
| `--last-answers`          | Skip the picker and reuse the selection it last saved.                                      |
| `--ui`                    | The terminal UI. The default.                                                               |
| `--headless`              | No UI: stream the log to stdout. Needs `-s`, `-t` or `--last-answers`.                      |
| `-d, --detach`            | For CI: a headless session that outlives the command. Needs `-s`, `-t` or `--last-answers`. |
| `--wait-timeout <s>`      | How long `--detach` waits for the session to be ready. Default `300`.                       |
| `--kill-others`           | Quit a session already running in this profile without asking.                              |

- **`-s` names a service by its name or by a path**, as
  [Naming a service](../guide/commands.md#naming-a-service) shows. A directory that belongs to
  no service is refused.
- **`-t` matches application services**, by their [`tags`](../config/services.md#tags). `-s`
  and `-t` add up: `stackctl -s web -t backend` runs `web` and every service tagged `backend`.
- **A service with no dev command is left unstarted**, picked or tagged.

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
are ready, and the session's own `afterStart` and `afterReady` [hooks](../config/lifecycle.md)
have finished, prints one line and exits `0`, leaving the session running:

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

Asks the profile's session to quit and waits for its services to stop and its
[stop hooks](../config/lifecycle.md) to run. A session that doesn't exit in time
is force-killed with its process tree. Exits `0` when there was nothing to stop
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
ready, and the session's own `afterStart` and `afterReady` [hooks](../config/lifecycle.md) have
finished, as [`startStack()`](./sdk.md#startstack) waits. Prints the session's pid, control API
port and log, and exits `0`.

| Option                | What it does                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `--timeout <seconds>` | How long to wait, from the start to ready. Default `300`.            |

- **Exits `1` with the reason** when a service stops while starting, a
  [start hook failed](../config/lifecycle.md) a service or one it waits on, the
  session's start fails, the session ends, or the timeout passes: it then names the hook a
  service still runs.
- **A session whose start failed since `wait` began** fails it at once, with the session's
  reason. With no session by the timeout, it says none started, and why the last one failed to
  start if it did.
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
stackctl service restart -t backend          # every service tagged backend
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

All take `-s, --service <service>` and `-t, --tag <tag>`, repeatable, and at least one of
them. `start` and `restart` wait until the services are ready, and exit `1` if one isn't.
`--wait-timeout <s>` (default `300`) bounds the whole command, the time a start waits behind a
stop's hooks included. For infra services, use [`stackctl infra`](#stackctl-infra).

- **`-s` and `-t` pick services as on [`start`](#stackctl-start).**
- **`start` and `restart` refuse a service named with `-s` that has no dev command**, and
  leave out one only a tag matched.
- **A service one of its start hooks failed fails the wait at once**, with the hook's error and
  the command to restart it. `start` of a `failed` one does nothing and exits `1`:
  `api is running, but failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session.`
  One whose `beforeStart` failed was not started:
  `api failed to start: beforeStart failed: boom. …`.
- **`stop` waits for the service's stop hooks**, however long they take, and names the one it
  waits for: `api's beforeStop is still running: the stop goes on once it has finished. To
  abandon the hook, stop the service again: stackctl service stop -s api`.
- **`stop` of a service still running a hook of its own
  [abandons](../config/lifecycle.md) that hook**:
  `stopped api: its beforeStop was still running, and was abandoned`. A stop is accepted during
  a restart too.

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
  [Finding the port](./control-api.md#finding-the-port) does. One whose own `afterStart` or
  `afterReady` is still to finish reads `running, its afterReady still to finish`, and one whose
  start failed `development session: failed to start: session afterReady failed: <message> (…)`.
- **Without a session it says so**, and why the last one failed to start, if it did:
  `The last one failed to start (today 11:41:53): session beforeStart failed: <message>`
  (`lastSessionError` in `--json`).
- **A service one of its start hooks failed** shows why:
  `api  failed, not ready: afterReady failed: boom` after its `afterStart` or `afterReady`,
  `api  stopped: beforeStart failed: boom` after its `beforeStart`, and a service waiting on it
  `web  waiting, not ready: waiting for api, which failed: …`.
- **A service still running a hook of its own** shows which:
  `api  running, not ready: its afterReady is still running`. One whose `beforeStop` still runs
  reads `stopping`.
- **A restart a stop came before** reads `cancelled, 0.2s`.
- **An infra command whose hook failed** says which service reached its state anyway:
  `failed, 2.0s (db stopped, but a hook failed)`.
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
stackctl show-config | jq '.services.api.envFiles'
```

Prints the fully resolved config as JSON, with no session: callbacks have run and defaults
are applied. It is the same object a session reports as `config` on
[`GET /query/status`](./control-api.md#get-querystatus).

| Field           | What it holds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `services`      | Each service's `port`, `publicOrigin`, `urls`, `healthcheck`, `deps`, `command`, `tags`, `dir` (as written), `resolvedDir` (absolute), and its [`env`](../config/services.md#env) combined with the config's: `envFiles`, `envOverride` and `envVars`. |
| `infra`         | Per provider: the compose `file`, the profile's `projectName`, and each service's `enabled`, `tags`, `port`, `urls` and `publicOrigin`. |
| `reverseProxy`  | Its `port`, `tls`, `publicAddress` and `routes`.                                       |
| `envFiles`      | The `.env` filenames the profile looks for in each directory, in load order. A service's own are on the service. |
| `workspaceDir`  | The workspace root, absolute.                                                          |
| `session`       | With a `session` in the config: `{ "lifecycle": {} }`.                                 |

Functions (`logs.formatter`, the [`lifecycle` hooks](../config/lifecycle.md)) have no JSON form
and are left out, so a `lifecycle` prints as `{}`.

## `stackctl exec` and `stackctl run`

```bash
stackctl exec [service] -- <command> [args...]
stackctl run [service] <script> [-- args...]
stackctl exec (-s <service>|-t <tag>)... -- <command> [args...]
stackctl run (-s <service>|-t <tag>)... <script> [-- args...]
```

Run one command, or one `package.json` script or Makefile target, in a service's directory
with its environment. A service is named by its name or by a path; a directory that belongs to
no service runs with the workspace's environment. The [One-off commands](../guide/commands.md)
guide covers both. Its log goes in the latest session's folder, under `commands/`. With `-s` or
`-t`, it runs in [several services at once](#several-services-at-once).

| Option                    | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `-s, --service <service>` | A service to run it in. Repeatable.                                  |
| `-t, --tag <tag>`         | Every service with the tag. Repeatable.                              |
| `--ignore-sibling-error`  | Run every command to its end when one fails. Only with `-s` or `-t`. |

- **`exec` needs the `--`.** Everything after it is the command.
- **`run` forwards what follows `--`** to the script. A script that doesn't exist is an error.
- **`run` first [type-checks the config](../config/config-file.md#type-checking)**, and exits on
  a type error. `exec` doesn't.
- **The exit code is the command's.**
- **On a terminal, the command gets it**, stdout and stderr each on its own, except for a coding
  agent, whose command is always piped. Its log then holds no output for that stream.

### Several services at once

```bash
stackctl run -t backend test
stackctl exec -s api -s worker -- node scripts/check.ts
```

```
2026-11-10 16:00:11 [api   ] 12 tests passed
2026-11-10 16:00:12 [worker] 4 tests passed
stackctl: 2 ok
  api     ok  1.2 seconds
  worker  ok  2.0 seconds
```

- **Any `-s` or `-t` is this form**, even when it names one service. A service argument beside
  them is an error: `run` then takes only the script, and `exec` only the command.
- **`-s` and `-t` pick services as on [`start`](#stackctl-start)**, and `-s` takes a directory
  that belongs to no service too, labelled with its path from the root. None runs twice: the
  services in config order, then the directories.
- **They all run at once**, each as the single form would run it in that service.
- **Each line is date-stamped and labelled**, as [`--headless`](#--headless) prints: stdout lines
  on stdout, stderr lines on stderr. Always piped: no command gets the terminal or stdin.
- **The first failure stops the rest**: a non-zero exit, an end by a signal stackctl didn't
  send, or a command that can't start. The others get `SIGTERM`, with their process trees.
  `--ignore-sibling-error` runs each to its end instead.
- **Ctrl+C or a `SIGTERM`** reaches every command.
- **A command stackctl stopped that still runs 5 seconds later** is killed with `SIGKILL`, and
  once it has ended, so is anything it left running in the background.
- **A `run` of a missing script:** a service named with `-s` that lacks it is an error before
  anything runs; one only a tag matched is skipped, with `skipping <service>: no "<script>"
  script` on stderr. A script none of them has is an error.
- **The summary goes to stderr** once the last command ends: each service as `ok`, `failed`
  (with its exit code or signal), `stopped` (stackctl stopped it) or `skipped`, and how long it
  ran.
- **Exits `0`** when every command that ran exited `0`. After Ctrl+C or a signal, the code the
  single form gives for it (`130` for Ctrl+C). Else `1`.
- **Each command has its own log** under `commands/` and its own
  [event](./events.md), as a single one does. A service's `logs.formatter` is not applied.
- **Inside a command stackctl runs**, the lines carry no date stamp, since the outer command
  stamps them, and no log or event is written.

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
stackctl infra start   [-s <name>...] [-t <tag>...]
stackctl infra stop    [-s <name>...] [-t <tag>...]
stackctl infra restart [-s <name>...] [-t <tag>...]
stackctl infra reset   [-s <name>...] [-t <tag>...]
stackctl infra destroy [-s <name>...] [-t <tag>...]
stackctl infra docker-compose [args...]
```

Drives the [infra](../config/infra.md) the config declares. `start`, `stop`, `restart` and
`reset` are the same actions as a session's `s`, `r` and `R` keys. Every subcommand exits when it
is done, and none disturbs a running session.

| Subcommand                 | What it does                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `start`                    | Starts the services, waits until each is ready and runs `afterReady`, then exits `0`, or `1` if one failed. They keep running. |
| `stop`                     | Stops and removes the containers. Named volumes are kept.                             |
| `restart`                  | `stop`, then `start`: the containers are recreated, picking up a changed compose file. Named volumes are kept. |
| `reset`                    | Removes the services **and their data**, then starts them clean. With no `-s` or `-t`, the whole project. See [`reset`](../config/infra.md#reset). |
| `destroy`                  | Removes the containers **and their data**, and starts nothing. With no `-s` or `-t`, the whole project. |
| `docker-compose [args...]` | Runs `docker compose <args>` on this project and profile, with your terminal.         |

- **`-s, --service <name>` picks the services** by an infra service's name, repeatable. With
  no `-s` and no `-t`, every enabled one, and for `reset` and `destroy` the whole project:
  `stackctl infra reset` deletes **every** infra service's data.
- **`-t, --tag <tag>` picks every enabled infra service with the tag**, by its
  [`tags`](../config/infra.md#tags), repeatable. It matches infra services only, and adds up
  with `-s`. A tag that matches no enabled one exits `1`, and acts on nothing.
- **A disabled infra service named with `-s` is an error**, before anything runs, on every
  subcommand but `destroy`, which removes it.
- **`--wait-timeout <seconds>`**, on `start`, `restart` and `reset`, is how long to wait for the
  services to be ready, over the config's [`readyTimeout`](../config/infra.md#options).
- **A service with no named volume keeps its data in its container**, so `stop` and `restart`
  lose it, and its next start is [`fresh`](../config/infra.md#seeding-with-fresh).
- **Exits `0`** when every service reached the state the subcommand names and no
  [lifecycle hook](../config/lifecycle.md) failed, else `1`.
- **A stop hook that fails doesn't hold the stop back**: `db  stopped, but beforeStop failed:
  boom`, and a `restart` still starts the service. A failed `afterDestroy` leaves the removal
  done (`db  destroyed, but afterDestroy failed: boom`), and a `reset` starts nothing.
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
| the command's | `exec` and `run`: their command's code; with `-s` or `-t`, `0`, `1` or the signal's code (`130` for Ctrl+C). |
| `130`, `143`  | `--detach` interrupted by Ctrl+C or `SIGTERM` while waiting.                |
