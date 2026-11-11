---
description: The infra option - run the databases, caches and brokers in docker-compose.yaml before your services, with readiness, per-mode Compose projects, enabled, and callbacks for migrations and seeds.
---

# Infra

Services usually need infrastructure beside them: a database, a cache, a message broker.
Declare it under `infra` and stackctl brings it up, waits until it is ready and runs your
setup steps, before any application service starts.

```ts
export default defineConfig({
  infra: { 'docker-compose': true },
  services: {/* … */},
});
```

That is a complete config for a project with a `docker-compose.yaml` at its root.

> [!NOTE]
> `infra` is keyed by provider, and **Docker Compose is the only provider**. It needs Docker
> with Compose v2. Images, ports, volumes and healthchecks stay in your compose file: stackctl
> runs Compose for you and adds what is on this page around it.

## How it behaves

- **A session starts infra first.** `stackctl` runs every enabled infra service, waits for
  each to be [ready](#readiness), then starts the application services.
- **Quitting leaves it running**, so the next start takes well under a second.
- **A failure stops the startup.** Services aren't started against a database that isn't
  there. The log has the infra service, the reason and the tail of its container's logs.
- **Its output is in the session log**, under `[infra]` and `[infra:<service>]`.
- **Each [mode](#modes) has its own containers**, so a test database never lands on the dev
  port.

In the terminal UI, infra services have their own footer row. Focus one with the arrow keys:

| Key | Action                                                                                |
| --- | ------------------------------------------------------------------------------------- |
| `s` | Start or stop it.                                                                     |
| `r` | Restart it. The container is recreated and its data kept.                             |
| `R` | Reset it, **deleting its data**. Asks for a second `R` within five seconds.           |

The same actions are on the [control API](../reference/control-api.md#post-commandinfra).

## Commands

`stackctl infra` does the same work without a session. Every command exits when it is done.

```sh
stackctl infra start                  # start everything, wait until ready, exit
stackctl infra start -s db            # only db
stackctl infra restart -s db          # recreate db's container, keep its data
stackctl infra reset -s db            # delete db's data, then start it clean
stackctl infra stop                   # stop and remove containers, keep the data
stackctl infra destroy                # remove containers and their data
stackctl infra docker-compose ps      # Compose itself, on this project and mode
stackctl --mode test infra start      # the test mode's own containers
```

See [`stackctl infra`](../reference/cli.md#stackctl-infra).

> [!WARNING]
> Use `stackctl infra docker-compose …`, not a bare `docker compose …`. stackctl names the
> Compose project per mode, so a bare command looks at a different, empty project.

## Options

```ts
infra: {
  'docker-compose': {
    file: './docker-compose.yaml',
    readyTimeout: 300_000,
    services: {
      db: {
        afterReady: async ({ exec }) => {
          await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
        },
      },
      mail: { port: 21054, urls: [''] },
      emulator: { enabled: ({ mode }) => mode !== 'test' },
    },
  },
},
```

| Option         | Default                | What it is                                                              |
| -------------- | ---------------------- | ----------------------------------------------------------------------- |
| `file`         | Compose's own discovery | The compose file, relative to the workspace.                           |
| `readyTimeout` | `300000` (5 minutes)   | How long `start` waits for the services to be ready, in ms.                |
| `services`     | none                   | Per-service options, keyed by Compose service name.                     |

**Every service in the compose file runs**, listed under `services` or not. List one to give
it options. A key that isn't a service in the compose file is an error.

Per-service options:

| Option                        | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| [`enabled`](#enabled)         | Turns the service off, by mode or by environment.                        |
| [`port`](#port-and-urls)      | Its host port, for the reverse proxy and footer links.                   |
| [`urls`](#port-and-urls)      | Footer links.                                                            |
| `publicOrigin`                | Overrides parts of its public origin. See [`publicOrigin`](./urls.md#publicorigin). |
| [`beforeStart`, `afterReady`, `beforeDestroy`, `afterDestroy`](#callbacks) | Your setup and teardown steps. |

### The compose file

stackctl hands Compose the mode's environment (the workspace's
[`.env` files](../guide/env.md) and `env.vars`), so the file can interpolate it:

```yaml
services:
  db:
    image: postgres:18.6
    ports:
      - '${DB_PORT}:5432' # from .env.development, or .env.test under --mode test
    healthcheck:
      test: ['CMD', 'pg_isready', '-h', '127.0.0.1']
```

## `enabled`

- **Type:** `boolean | ({ mode, envs, tokens, service }) => boolean`
- **Default:** `true`

```ts
services: {
  emulator: { enabled: ({ mode }) => mode !== 'test' },
  tracing: { enabled: ({ envs }) => Boolean(envs.TRACING_API_KEY) },
}
```

A disabled service is left out of `infra start` and of sessions, and its callbacks don't run.
Two things it doesn't do:

- **It doesn't override `depends_on`.** If an enabled service depends on a disabled one,
  Compose starts both.
- **It doesn't stop a container that is already running.**

## `port` and `urls`

Give an infra service a `port`, the host side of its port mapping, to route it through the
[reverse proxy](./reverse-proxy.md) or link to it in the footer. stackctl doesn't read the
port from the compose file.

```ts
reverseProxy: {
  port: 4000,
  routes: [{ subdomain: 'mail', service: 'mail' }],
},
infra: {
  'docker-compose': {
    services: {
      mail: { port: ({ envs }) => Number(envs.MAIL_UI_PORT), urls: [''] },
    },
  },
},
```

Mailpit's web UI is then at `http://mail.localhost:4000`, with a `mail ↗` link in the footer.
`urls` takes the same entries as [a service's](./urls.md#links-in-the-footer).

## Callbacks

Async functions that run around stackctl's own steps:

| Callback        | Runs                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| `beforeStart`   | On every start, before the services are started.                                              |
| `afterReady`    | On every start, once the service is ready, **including when it was already running**.         |
| `beforeDestroy` | Before the service's containers and data are removed (`destroy`, `reset`).                    |
| `afterDestroy`  | After they are removed. For state Compose can't see, such as a bind-mounted directory.        |

`afterReady` runs at every session start on purpose: pull a branch with new migrations, start
stackctl, and they are applied. So what it runs must be idempotent.

```ts
db: {
  afterReady: async ({ exec, fresh }) => {
    await exec('pnpm', ['migrate'], { cwd: 'libs/db' }); // every time
    if (fresh) {
      await exec('pnpm', ['seed'], { cwd: 'libs/db' }); // only into a new database
    }
  },
},
```

A callback that throws fails its service. A failing `beforeDestroy` stops the run before
anything is removed, and a failing `beforeStart` before anything is started.

### What a callback receives

| Field          | What it is                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| `exec`         | `exec(command, args?, opts?)`: runs a command with the mode's environment.                  |
| `compose`      | `compose(args, opts?)`: runs `docker compose <args>` on this project.                       |
| `log`          | `log(message)`: writes a line to the infra output.                                          |
| `fresh`        | `afterReady` only. `true` when this run created the service's data.                         |
| `reset`        | `true` when this run is a reset.                                                            |
| `mode`         | The active mode.                                                                            |
| `envs`         | The mode's workspace environment, which `exec` and `compose` give their commands.           |
| `tokens`       | The config's top-level `tokens`.                                                            |
| `config`       | The resolved config, read-only: every service's `port` and `publicOrigin`.                  |
| `service`      | This infra service: `{ name, kind, port, route, publicOrigin }`.                            |
| `buildAddress` | Builds a URL from the service's origin. See [`buildAddress`](./urls.md#buildaddress).        |
| `workspaceDir` | The workspace root, absolute.                                                               |
| `control`      | A client for the running session, or `undefined`. See [Driving the session](#driving-the-session). |
| `data`         | An object the service's callbacks share for one run, empty when it starts.                  |

`exec` and `compose` take `{ cwd?, env?, reject? }` and resolve with
`{ exitCode, stdout, stderr }`.

- **`cwd`** is relative to the workspace root, the default.
- **A non-zero exit rejects**, failing the service, unless you pass `reject: false`.
- **Their environment is `envs`**: the workspace-scope variables and `STACKCTL_MODE`. A
  variable from one service's own `.env` file isn't there. Pass it with `env`.
- **Use them for anything a callback runs or prints.** A child process you spawn yourself with
  inherited stdio draws over the terminal UI.

### Seeding with `fresh`

`fresh` is `true` when this run created the service's data: none of its named volumes existed
before.

| What happened                         | `fresh` |
| ------------------------------------- | ------- |
| The service's first start             | `true`  |
| `infra start` again                   | `false` |
| `infra stop`, then `infra start`      | `false` |
| `infra restart`                       | `false` |
| `infra destroy`, then `infra start`   | `true`  |
| `infra reset`                         | `true`  |

Nothing is remembered between runs. If `afterReady` fails on the fresh run, before the seed,
`fresh` is `false` next time: start over with `stackctl infra reset -s <service>`.

### Driving the session

`control` is a [control API](../reference/control-api.md#the-client) client for the session
running in this mode, or `undefined` when there is none. It is for a service that holds on to
an infra service's data. Stop it before a reset, start it again after:

```ts
db: {
  beforeDestroy: async ({ reset, control, data }) => {
    const status = await control?.query.status();
    if (reset && status?.services?.api === 'running') {
      data.apiWasRunning = await control?.command.service.stop('api');
    }
  },
  afterReady: async ({ exec, control, data }) => {
    await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
    if (data.apiWasRunning) {
      await control?.command.service.start('api');
    }
  },
},
```

- **At a session's own start the services aren't running yet**, so there is nothing to stop.
  This acts on a reset made while the session runs.
- **Leave the callback's own infra service alone**, and don't `quit()` from a callback.

## Modes

stackctl sets the Compose project name to `<workspace directory>-<mode>`: `example-development`,
`example-test`. Each mode is its own project, with its own containers, volumes and network, so
`stackctl infra start` and `stackctl --mode test infra start` run side by side on the ports from
their own `.env.<mode>` files.

To choose the name yourself, set `COMPOSE_PROJECT_NAME` in a `.env` file.

## Readiness

An infra service is ready when its container is:

- `running` and `healthy`, if the compose file gives it a `healthcheck`;
- `running`, if it has none;
- `exited` with code `0`: a one-shot service, such as an init container, that finished.

stackctl adds no probe of its own. Give a service a Compose `healthcheck` whenever "the
container is running" isn't the same as "it accepts connections".

## What `destroy` removes

| You name…   | What goes                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------- |
| no services | The whole project: every container, named and anonymous volume, and network.                |
| services    | Those services' containers, and the volumes **only they** mount. The network stays.         |

`infra reset` works the second way, on the services it is about to start. Images,
`external` volumes and bind-mounted host directories are never removed: clean up the last in
`afterDestroy`.
