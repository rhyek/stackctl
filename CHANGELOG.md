# Changelog

## 0.5.0

### Features

- **Each session keeps its log and event log in a folder of its own**, so `stackctl logs`,
  `stackctl events` and `stackctl status` show one session: the running one, else the latest.
  See [docs/guide/logs.md](docs/guide/logs.md#log-files).
- **`stackctl wait` blocks until the mode's session is ready**, for a session started in the
  background. See [docs/reference/cli.md](docs/reference/cli.md#stackctl-wait).
- **`stackctl exec` and `run` give the terminal to the command**, so its prompts, colors and
  watch-mode keys work. See [docs/guide/commands.md](docs/guide/commands.md#output-and-exit-code).
- **The SDK's `exec()` and `run()` are in the event log**, as `stackctl exec` and `run` are.

### Fixes

- **The run screen's footer no longer leaves an empty row** under the keys while a service waits.

### Breaking changes

- **Logs and event logs moved to `node_modules/.stackctl/modes/<mode>/sessions/<id>/`**: read
  `logs.txt` and `events.jsonl` there, or ask `stackctl logs --path` and `stackctl events --path`.
- **`--log-dir` and `startStack()`'s `logDir` are gone**: a CI job that kept its logs uploads
  `node_modules/.stackctl/modes/<mode>/sessions/` instead.
- **A `sessionId` is the session's start time in ms, no longer a UUID**: treat it as an opaque
  string.
- **A coding agent's command must name its mode**: pass `--mode development` (or the mode
  meant) where an agent's script or prompt relied on the default.
- **A service waiting for its dependencies can't be started or restarted early**: start the
  services it waits for instead.

## 0.4.0

### Features

- **`stackctl status` shows the mode's session and the last commands that acted on it.** See
  [docs/reference/cli.md](docs/reference/cli.md#stackctl-status).
- **Each mode keeps an event log of what acts on its stack**, by a key, a control API request or
  a stackctl command, with who asked; `GET /events` streams the same lines and `stackctl events`
  prints them. See [docs/reference/events.md](docs/reference/events.md).
- **A session's first start offers a rules file for coding agents beside the skill**, so an
  agent knows what stackctl runs in the repo without having to pick the skill, and
  `stackctl init --agents-md` adds the same lines to `AGENTS.md`. See
  [docs/ai/overview.md](docs/ai/overview.md#agent-guidance).
- **The package ships its skill in `skills/`**, where `pnpm approve` can link it.

### Breaking changes

- **Installing stackctl no longer writes the agent skill**: a session's first start in a
  terminal offers it, and `stackctl init -y` installs it from a script.
- **`GET /events` streams the event log, whose state lines are `service-state`, `infra-state`
  and `session-state`**: match `"type":"session-state","ready":true` where you matched
  `"type":"session","ready":true`, and give a `switch` over `SessionEvent` a `default`.

## 0.3.0

### Features

- **Infra callbacks get `trigger`, the run that called them**: a session's start, `start`,
  `restart`, `reset` or `destroy`. See
  [docs/config/infra.md](docs/config/infra.md#what-started-the-run).

### Breaking changes

- **Installing stackctl no longer writes the agent skill**: a session's first start in a
  terminal offers it, and `stackctl init -y` installs it from a script.
- **The infra callbacks' `reset` is gone**: test `trigger === 'reset'` instead.
- **Only Docker Compose's callback types have `compose`**: type a callback with
  `DockerComposeDestroyContext`, `DockerComposeStartContext` or `DockerComposeReadyContext` in
  place of `InfraCallbackContext` or `InfraReadyContext`, and a services map with
  `DockerComposeServiceInput` and `DockerComposeServicesInput` in place of `InfraServiceInput`
  and `InfraServicesInput`.

## 0.2.0

### Features

- **`stackctl infra restart` recreates infra containers and keeps their data**, as the footer's
  `r` does.

### Fixes

- **The footer's `^c quit` no longer wraps onto a row of its own**, and the keys row's groups
  sit closer together.

### Breaking changes

- **Installing stackctl no longer writes the agent skill**: a session's first start in a
  terminal offers it, and `stackctl init -y` installs it from a script.
- **`stackctl infra` takes a session's verbs, with services named by `-s`**: `up` is `start`,
  `down` is `stop` and `up --reset` is `reset`. Change `stackctl infra up db` to
  `stackctl infra start -s db`, and the same for `destroy`. See
  [docs/reference/cli.md](docs/reference/cli.md#stackctl-infra).
- **The infra callback `beforeUp` is `beforeStart`.** Rename it in `stackctl.config.ts`.

## 0.1.3

- **A stackctl started from a process stackctl started keeps the shell's own value of a
  variable `env.override` appends to**, such as a debugger's `NODE_OPTIONS`.

## 0.1.2

- **Every log line's text starts in the same column**, infra's and those of a service added
  mid-session included.
- **Commands received over the control API are logged under `[control]`**, rather than
  `[dt:control]`.

## 0.1.1

- **The README and the docs name stackctl's SDK**: `startStack()`, `exec()`, `run()` and
  `resolveEnv()`, for your own scripts and test suites. See [docs/reference/sdk.md](docs/reference/sdk.md).

## 0.1.0

First release of stackctl, a terminal UI and CLI for a monorepo's services, infrastructure,
tests and CI during development. See [README.md](README.md).

- **One typed config file** (`stackctl.config.ts`) describes every service and the services it
  depends on.
- **An interactive terminal UI** to pick services and watch their combined, filterable logs and
  memory use.
- **A headless mode, `startStack()` and a control API** run the same stack from CI, an e2e suite
  or a coding agent, with an installable agent skill.
- **Infra from `docker-compose.yaml`**, brought up and migrated per mode before the services
  start. See [docs/config/infra.md](docs/config/infra.md).
- **Per-service `.env` loading**, live-reloaded, and JSON logs formatted for reading.
- **An optional dev reverse proxy** gives each service its own hostname. See
  [docs/config/reverse-proxy.md](docs/config/reverse-proxy.md).
