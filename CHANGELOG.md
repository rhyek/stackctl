# Changelog

## 0.12.0

### Features

- **Application services take lifecycle hooks: `beforeStart`, `afterStart`, `afterReady`,
  `beforeStop` and `afterStop`.** See [docs/config/lifecycle.md](docs/config/lifecycle.md).
- **The session takes the same hooks under `session.lifecycle`**, from a `beforeStart` before its
  infra to an `afterStop` as it quits. See [docs/config/lifecycle.md](docs/config/lifecycle.md#the-session).
- **The Compose project takes the same hooks, and `beforeDestroy` and `afterDestroy`, under
  `infra['docker-compose'].lifecycle`**, around every service's. See
  [docs/config/lifecycle.md](docs/config/lifecycle.md#the-compose-project).
- **Infra services take `afterStart`, `beforeStop` and `afterStop` too.** See
  [docs/config/lifecycle.md](docs/config/lifecycle.md#an-infra-service).
- **A service one of its start hooks failed says why in `stackctl status`, the control API and
  the proxy's page**: `failed` after `afterStart` or `afterReady`, `stopped` after `beforeStart`.
  See [docs/reference/control-api.md](docs/reference/control-api.md#get-querystatus).
- **`stackctl status` names the hook a service still runs**, and `GET /query/status` has it as
  `serviceHooks`. See [docs/reference/control-api.md](docs/reference/control-api.md#get-querystatus).
- **`stackctl status`, `stackctl wait` and `start --detach` say why a session failed to start**,
  `status` and `wait` also once it is gone.
- **JSON logs that keep their message under `message`, as NestJS's do, show it in the
  `[LEVEL] message` header.** See [docs/guide/logs.md](docs/guide/logs.md#json-logs-are-formatted-for-you).

### Fixes

- **`--wait-timeout` bounds the whole of `stackctl service start`**, the time it waits for a
  service still stopping included.
- **A command an infra hook runs ends with `stackctl infra`**, and with everything it started,
  when the command is interrupted or killed too.

### Breaking changes

- **An infra service's callbacks live under `lifecycle`.** Wrap `beforeDestroy`, `afterDestroy`,
  `beforeStart` and `afterReady` in `lifecycle: { … }`.
- **A compose file's top-level `name:` names the Compose project as it is, with no profile
  added.** To keep the containers and data stackctl made under `<directory>-<profile>`, set
  `COMPOSE_PROJECT_NAME=<directory>-<profile>` in each `.env.<profile>`. See
  [docs/config/infra.md](docs/config/infra.md#profiles).
- **Every hook of one operation shares one `data`, across services.** Where two services' hooks
  use the same key, put each under its service's name: `data.db = { … }`. See
  [docs/config/lifecycle.md](docs/config/lifecycle.md#sharing-data).
- **A service's status can be `failed`** in `GET /query/status`, `/events`, the event log and
  `stackctl status --json`: handle it wherever you read the status.
- **A stop during a restart stops the service**, through `stackctl service stop` or
  `POST /command/service/stop`, where it was refused: drop any retry of a stop on `409`.
- **An infra service whose `afterDestroy` failed is reported `destroyed`, with the error**, not
  `failed`: check `ok` or `error` in scripts.
- **A restart a stop cancels ends `ok: false` with `outcome: 'cancelled'`** in the event log,
  not `done`: read `outcome` where you read a restart's end.
- **A wait that runs out of time says `not ready after <n>s`**, not `not healthy after`: update
  a script that matches the message.

## 0.11.2

### Fixes

- **A session no longer fails to start when another one takes its control API port at the same
  moment.**

## 0.11.1

### Features

- **JSON logs list nested objects and arrays field by field, and nested stack traces keep their
  line breaks.** See [docs/guide/logs.md](docs/guide/logs.md#json-logs-are-formatted-for-you).

## 0.11.0

### Features

- **Services and infra services take `tags`, and `-t, --tag` picks them wherever `-s` does.** See
  [docs/config/services.md](docs/config/services.md#tags).
- **`-s` names a service by its name or by a path** on `start`, `service`, `run` and `exec`. See
  [docs/guide/commands.md](docs/guide/commands.md#naming-a-service).
- **`run` and `exec` run in several services at once** with `-s` and `-t`. See
  [docs/guide/commands.md](docs/guide/commands.md#several-services-at-once).
- **The SDK's `exec()` and `run()` take several services or `tags`, and `startStack()` takes `tags`.**
  See [docs/reference/sdk.md](docs/reference/sdk.md#several-services-at-once).
- **The SDK's `attach()` and `wait()` return the stack of a session already running**, wherever it
  was started. See [docs/reference/sdk.md](docs/reference/sdk.md#attach-and-wait).
- **The SDK does what the CLI's commands do**: `infra.*`, `service.*`, `stop()`, `status()`,
  `events()`, `logs()`, `showConfig()`, `resetProfile()` and `init()`. See
  [docs/reference/sdk.md](docs/reference/sdk.md).
- **`infra start`, `restart` and `reset` take `--wait-timeout`.** See
  [docs/reference/cli.md](docs/reference/cli.md#stackctl-infra).

### Breaking changes

- **A service's `targetDir` is `dir`, and `resolvedTargetDir` is `resolvedDir`**: rename them in
  `stackctl.config.ts` and wherever you read `show-config`, the control API or the exported config.
- **The SDK's `target` option of `exec()`, `run()` and `resolveEnv()` is `service`**: rename it in
  your calls.
- **The SDK no longer exports `findService`**: read `config.services[name]` from your config instead.
- **`infra reset` with nothing named resets the profile's whole Compose project**, disabled
  services' data included: name the services with `-s` to keep a disabled one's data.
- **`infra reset` and `infra destroy` refuse, before anything runs, a volume or network they
  couldn't remove**: act on services that share a volume together, as the message shows, and
  remove the container that holds it. See
  [docs/config/infra.md](docs/config/infra.md#reset).
- **`infra reset` and `infra destroy` refuse a service that mounts an `external` volume**: clear
  its data yourself, then `infra restart -s <service>`.
- **`infra stop` and `infra restart` act on enabled services only**, and refuse a disabled one
  named with `-s`: remove a disabled service's container with `infra destroy -s <service>`.
- **A named `infra reset` removes a volume a disabled service also uses**, when no container holds
  it: name only the services whose data may go.
- **`infra stop` exits `0` or `1`**, not Compose's own code: check for `1` in scripts.

## 0.10.0

### Features

- **A service takes an `env` of its own**: `vars`, `override` and `additionalFiles` for it
  alone, on top of the config's unless `inherits: false`. See
  [docs/config/services.md](docs/config/services.md#env).
- **`services` is optional in `stackctl.config.ts`**, for a config that only sets the
  environment of `exec` and `run`.

## 0.9.0

### Features

- **`.env` files load from every directory between the workspace root and a service**, the
  nearest winning. See [docs/guide/env.md](docs/guide/env.md#which-files-load).

### Breaking changes

- **A service's `relativeDir` is now `targetDir`**, and the resolved service's `relativeDir` and
  `absoluteDir` are `targetDir` and `resolvedTargetDir`: rename them in `stackctl.config.ts` and
  wherever you read `show-config`, the control API or the exported config.
- **`.env` files in a directory between the root and a service now load**: move any a service
  shouldn't read.
- **`env.additionalFiles` entries take no `scope`**: drop it; each file is looked for in every
  directory.
- **`env.additionalFiles` names the file it loads next to**: replace `before`/`after` values
  `'base'`, `'local'`, `'profile'` and `'profileLocal'` with `'.env'`, `'.env.local'`,
  `'.env.<profile>'` and `'.env.<profile>.local'`.
- **A service's `targetDir` must be inside the workspace**: move a service that lives outside it.
- **`config.envFiles` is one list of filenames**: read it in place of `.workspace` and
  `.service`; the `EnvFileOrder` and `EnvFileScope` types are gone.
- **`envCandidatePaths` is no longer exported**: read `candidates` from `resolveEnv()` instead.

## 0.8.1

### Fixes

- **The config type check before `start` and `run` takes about a third of the time, and an error
  inside a declaration file no longer fails it.**

## 0.8.0

### Features

- **`stackctl start` and `stackctl run` type-check `stackctl.config.ts` first.** See
  [docs/config/config-file.md](docs/config/config-file.md#type-checking).

### Breaking changes

- **Modes are now profiles**: replace `--mode`/`-m` with `--profile`/`-p`, `STACKCTL_MODE` with
  `STACKCTL_PROFILE`, `mode` with `profile` in config callbacks, `startStack()`, the SDK and the
  control API, and the `env.additionalFiles` anchors `'mode'`/`'modeLocal'` with
  `'profile'`/`'profileLocal'`. See [docs/guide/env.md](docs/guide/env.md#profiles).
- **A session's state lives in `node_modules/.stackctl/profiles/<profile>/`**: stop running
  sessions before upgrading, and the picker starts without your last selection.
- **`start` and `run` refuse a `stackctl.config.ts` with type errors**: fix what tsc reports.

## 0.7.2

### Features

- **The run screen's footer marks the focused service with a `❯`, as the picker does**, and the
  key hints sit closer together.
- **The run screen's log filter opens with `/`, as the picker's does**, in place of `f`.

## 0.7.1

### Features

- **The run screen highlights the filter's terms in the log lines it shows.**

## 0.7.0

### Features

- **A `${VAR}` in a `.env` file expands to the variable's final value, whichever file sets it**,
  as in Vite, so `.env` can build URLs from ports each mode's file sets. See
  [docs/guide/env.md](docs/guide/env.md#details).

### Breaking changes

- **A `${VAR}` sees the value a later file gives the variable, not the one before it**: where a
  reference needs the earlier value, give that value a name of its own.

## 0.6.0

### Features

- **`env.decrypt` decrypts `.env` values encrypted with dotenvx**, so a file of secrets can be
  committed. See [docs/config/env.md](docs/config/env.md#envdecrypt).

### Fixes

- **`sctl exec` or `sctl run` in a dev script no longer logs twice, records an event or keeps a process running.**
  See [docs/guide/commands.md](docs/guide/commands.md#output-and-exit-code).
- **Every command that reads the config starts about 65 ms sooner**, and `sctl exec` and
  `sctl run` about 110 ms sooner.
- **An infra callback's `exec` says why a command couldn't start**, a missing `cwd` included.
- **stackctl installs 19 fewer packages.**

### Breaking changes

- **`stackctl` no longer exports `z`**: for a `logs.formatter` that validates with zod, add `zod`
  to your own dependencies and import `z` from it.
- **An `.env` value encrypted with dotenvx stays encrypted unless `env.decrypt` is set**: add
  `env: { decrypt: true }` to `stackctl.config.ts`.

## 0.5.1

### Fixes

- **`stackctl events -f` no longer skips a line written as it starts.**

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
