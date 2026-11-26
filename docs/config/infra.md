---
description: The infra option - run the databases, caches and brokers in docker-compose.yaml before your services, with readiness, per-profile Compose projects, enabled, and what lifecycle hooks get only on infra - fresh for seeding, control to drive the session, compose, the project's hooks and reset.
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
- **Each [profile](#profiles) has its own containers**, so a test database never lands on the
  dev port.

In the terminal UI, infra services have their own footer row. Focus one with the arrow keys:

| Key | Action                                                                                |
| --- | ------------------------------------------------------------------------------------- |
| `s` | Start or stop it.                                                                     |
| `r` | Restart it. The container is recreated and its named volumes kept.                    |
| `R` | Reset it, **deleting its data**. Asks for a second `R` within five seconds.           |

The same actions are on the [control API](../reference/control-api.md#post-commandinfra).

## Commands

`stackctl infra` does the same work without a session. Every command exits when it is done.

```sh
stackctl infra start                  # start everything, wait until ready, exit
stackctl infra start -s db            # only db
stackctl infra restart -s db          # recreate db's container, keep its volumes
stackctl infra reset -s db            # delete db's data, then start it clean
stackctl infra restart -t data        # every infra service tagged data
stackctl infra stop                   # stop and remove containers, keep the volumes
stackctl infra destroy                # remove containers and their data
stackctl infra docker-compose ps      # Compose itself, on this project and profile
stackctl --profile test infra start   # the test profile's own containers
```

See [`stackctl infra`](../reference/cli.md#stackctl-infra).

> [!WARNING]
> Use `stackctl infra docker-compose …`, not a bare `docker compose …`. stackctl hands Compose
> the profile's environment and, unless the repo [names the project](#profiles), a project name
> per profile, so a bare command can look at a different, empty project.

## Options

```ts
infra: {
  'docker-compose': {
    file: './docker-compose.yaml',
    readyTimeout: 300_000,
    services: {
      db: {
        lifecycle: {
          afterReady: async ({ exec }) => {
            await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
          },
        },
      },
      mail: { port: 21054, urls: [''] },
      emulator: { enabled: ({ profile }) => profile !== 'test' },
    },
  },
},
```

| Option         | Default                | What it is                                                              |
| -------------- | ---------------------- | ----------------------------------------------------------------------- |
| `file`         | Compose's own discovery | The compose file, relative to the workspace.                           |
| `readyTimeout` | `300000` (5 minutes)   | How long `start` waits for the services to be ready, in ms. `--wait-timeout` overrides it. |
| `lifecycle`    | none                   | Hooks for the whole project. See [The project's hooks](#the-projects-hooks). |
| `services`     | none                   | Per-service options, keyed by Compose service name.                     |

**Every service in the compose file runs**, listed under `services` or not. List one to give
it options. A key that isn't a service in the compose file is an error.

Per-service options:

| Option                        | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| [`enabled`](#enabled)         | Turns the service off, by profile or by environment.                     |
| [`tags`](#tags)               | Labels for picking services together.                                    |
| [`port`](#port-and-urls)      | Its host port, for the reverse proxy and footer links.                   |
| [`urls`](#port-and-urls)      | Footer links.                                                            |
| `publicOrigin`                | Overrides parts of its public origin. See [`publicOrigin`](./urls.md#publicorigin). |
| [`lifecycle`](#callbacks)     | Your setup and teardown steps, the [lifecycle hooks](./lifecycle.md): `beforeStart`, `afterStart`, `afterReady`, `beforeStop`, `afterStop`, `beforeDestroy`, `afterDestroy`. |

### The compose file

stackctl hands Compose the profile's environment (the workspace's
[`.env` files](../guide/env.md) and `env.vars`), so the file can interpolate it:

```yaml
services:
  db:
    image: postgres:18.6
    ports:
      # from .env.development, or .env.test under --profile test
      - '${DB_PORT}:5432'
    healthcheck:
      test: ['CMD', 'pg_isready', '-h', '127.0.0.1']
```

## `enabled`

- **Type:** `boolean | ({ profile, envs, tokens, service }) => boolean`
- **Default:** `true`

```ts
services: {
  emulator: { enabled: ({ profile }) => profile !== 'test' },
  tracing: { enabled: ({ envs }) => Boolean(envs.TRACING_API_KEY) },
}
```

A disabled service is left out of `infra start`, `stop` and `restart` and of sessions, and its
callbacks don't run. Naming it with `-s` is an error on every `infra` command but `destroy`.
Two things it doesn't do:

- **It doesn't override `depends_on`.** If an enabled service depends on a disabled one,
  Compose starts both.
- **It doesn't stop a container that is already running.**

## `tags`

- **Type:** `string[]`
- **Default:** `[]`

```ts
services: {
  db: { tags: ['data'] },
  cache: { tags: ['data'] },
}
```

Labels for picking services together with `-t, --tag`, as on an
[application service](./services.md#tags). A service carries tags only when it is named under
`services`: one that is in the compose file and not listed here has none.

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

An infra service's `lifecycle` takes the [lifecycle hooks](./lifecycle.md): `beforeStart`,
`afterStart`, `afterReady`, `beforeStop`, `afterStop`, `beforeDestroy` and `afterDestroy`. That
page has when each runs and in what order, what it receives, what a failure does and how hooks
share `data`. What is only about infra is here.

```ts
db: {
  lifecycle: {
    afterReady: async ({ exec, fresh }) => {
      // every time
      await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
      if (fresh) {
        // only into a new database
        await exec('pnpm', ['seed'], { cwd: 'libs/db' });
      }
    },
  },
},
```

- **`afterStart` and `afterReady` run on every start, including when the service was already
  running.** That is on purpose: pull a branch with new migrations, start stackctl, and they are
  applied. So what `afterReady` runs must be idempotent. To skip it on some runs, read
  [`trigger`](#what-started-the-run).
- **Which run starts, stops or destroys, and the order of its hooks**, are on
  [Lifecycle hooks](./lifecycle.md#the-compose-project).
- **`afterDestroy` is for state Compose can't see**, such as a bind-mounted directory.

### What a callback receives

The [lifecycle context](./lifecycle.md#what-a-hook-receives), and:

| Field          | What it is                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| `trigger`      | What started this run. See [What started the run](#what-started-the-run).                    |
| `compose`      | `compose(args, opts?)`: runs `docker compose <args>` on this project.                       |
| `fresh`        | `afterReady` only. `true` when this run created the service's data. See [Seeding with `fresh`](#seeding-with-fresh). |
| `service`      | This infra service: `{ name, kind, port, route, publicOrigin }`.                            |
| `buildAddress` | Builds a URL from the service's origin. See [`buildAddress`](./urls.md#buildaddress).        |
| `control`      | A client for the running session, or `undefined`. See [Driving the session](#driving-the-session). |

- **`compose` takes the options [`exec`](./lifecycle.md#exec) takes**, and resolves as it
  does, with the profile's project name and compose file applied.
- **`exec` and `compose` run with the workspace's [`envs`](./lifecycle.md#what-a-hook-receives).**
  A variable from a `.env` file below the root isn't there: pass it with `env`.
- **Their output is in the infra output**, under the service's name.

### Seeding with `fresh`

`fresh` is `true` when this run created the service's data: none of its named volumes existed
before. A service with no named volume keeps its data in its container, so for it `fresh` is
`true` whenever it had no container: after `infra stop` and `infra restart` too.

| What happened                         | `fresh`                       |
| ------------------------------------- | ----------------------------- |
| The service's first start             | `true`                        |
| `infra start` again                   | `false`                       |
| `infra stop`, then `infra start`      | `false` (with a named volume) |
| `infra restart`                       | `false` (with a named volume) |
| `infra destroy`, then `infra start`   | `true`                        |
| `infra reset`                         | `true`                        |

Nothing is remembered between runs. If `afterReady` fails on the fresh run, before the seed,
`fresh` is `false` next time: start over with `stackctl infra reset -s <service>`.

### What started the run

`trigger` names the run that is calling the callback: `session`, `start`, `stop`, `restart`,
`reset` or `destroy`, each callback getting only the runs it is part of. The
[`trigger` table](./lifecycle.md#trigger) lists them. To migrate at a session's start only into
new data:

```ts
db: {
  lifecycle: {
    afterReady: async ({ exec, fresh, trigger }) => {
      if (fresh || trigger !== 'session') {
        await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
      }
    },
  },
},
```

- **A pulled migration then waits for an explicit start:** `stackctl infra start -s db` runs
  `afterReady` on the running service, without restarting it.

### Driving the session

`control` is a [control API](../reference/control-api.md#the-client) client for the session
running in this profile, or `undefined` when there is none. It is for a service that holds on to
an infra service's data. Stop it before a reset, start it again after:

```ts
db: {
  lifecycle: {
    beforeDestroy: async ({ trigger, control, data }) => {
      const status = await control?.query.status();
      if (trigger === 'reset' && status?.services?.api === 'running') {
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
},
```

- **At a session's own start (`trigger` is `session`) the services aren't running yet**, so
  there is nothing to stop.
  This acts on a reset made while the session runs.
- **Leave the callback's own infra service alone**, and don't `quit()` from a callback.

## The project's hooks

The provider's own `lifecycle` takes the same hooks, once per run, around every service's: its
`before…` before theirs, its `after…` after theirs. For setup that belongs to the Compose project
rather than to one service:

```ts
infra: {
  'docker-compose': {
    lifecycle: {
      beforeStart: async ({ config, exec }) => {
        const name = config.infra?.['docker-compose']?.projectName;
        // a network an older script made by hand, for Compose to own
        await exec('node', [
          'scripts/adopt-network.ts',
          `${name}_default`,
        ]);
      },
    },
    services: {/* … */},
  },
},
```

- **They run on the same runs as a service's hooks, around them.** The
  [order](./lifecycle.md#examples) is on the lifecycle page.
- **They run even when no service is enabled**, since what they do is about the project. A
  failure then fails the command itself.
- **They get the [callback context](#what-a-callback-receives) without the service**: no
  `service`, `buildAddress`, `fresh` or `control`. `compose`, `config` (with the profile's
  `projectName`) and `data` are there.
- **A failure is reported on every service of the run**, with the project's key:
  `docker-compose afterStart failed: <message>`. A failed start hook fails them; after a stop or
  a removal they are reported stopped or destroyed, but with the message.

## Profiles

stackctl sets the Compose project name to `<workspace directory>-<profile>`:
`example-development`, `example-test`. Each profile is its own project, with its own containers,
volumes and network, so `stackctl infra start` and `stackctl --profile test infra start` run
side by side on the ports from their own `.env.<profile>` files.

To choose the name yourself, set `COMPOSE_PROJECT_NAME` in a `.env` file or give the compose
file a top-level `name:`. stackctl uses the name as it is, with no profile added, and
`COMPOSE_PROJECT_NAME` wins over `name:`.

- **One name for every profile makes them one Compose project**: a [`reset`](#reset) or a
  `destroy` with nothing named then acts on every profile's infra. That is a `name:` without
  the profile in it, or `COMPOSE_PROJECT_NAME` in a file every profile reads (`.env`,
  `.env.local`).
- **To keep each profile its own**, set `COMPOSE_PROJECT_NAME` in `.env.<profile>`, or put the
  profile in the name: `name: shop-${STACKCTL_PROFILE:-development}`.
- **A repo already run with `docker compose`** has containers under its directory's name. With
  no name chosen, stackctl starts a new project beside them, and the old containers keep their
  ports. Run `docker compose down` first, or keep them with `name: <directory>`.

A stackctl profile is not a Compose profile: stackctl passes no `--profile` to Compose.

## `reset`

```sh
stackctl infra reset                 # the whole profile's infra, clean
stackctl infra reset -s db           # db alone
```

- **With nothing named, the profile's whole Compose project is reset**: the destroy hooks, the
  project removed with its volumes and network, disabled services' data included, then the
  start hooks, and the enabled services started, with `fresh: true` in `afterReady`.
- **With services named**, those services: their containers and the volumes they mount, with
  the same callbacks. A volume a disabled service also uses goes too.
- **On infra that doesn't exist yet**, whole or in part, it starts it, fresh.
- **It refuses, before any callback runs and before anything is removed,** what it couldn't
  delete, naming it and why: an `external` volume, and a volume, or with nothing named the
  project's network, in use by a container it doesn't remove: another project's, a
  `docker compose run` container (with nothing named, a running one), or with services named
  this project's container of another service.
  With services named, a volume another enabled service also uses is refused too, with the
  command that resets them together, in the same profile:

  ```
  can't reset db: volume example-test_pgdata is also used by db-init; reset them together: stackctl --profile test infra reset -s db -s db-init
  ```

  The terminal UI's `R` key and the control API reset one service, so they are refused the
  same way, and the services are reset together from the command line.
- **A service that mounts an `external` volume can't be reset or destroyed**: clear its data
  yourself, then `stackctl infra restart -s <service>`.

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

It refuses up front what it couldn't remove, as [`reset`](#reset) does: an `external` volume, a
volume or network in use by a container it doesn't remove, and with services named a volume
another service also uses, disabled ones included, since destroying it would take their data.
Images and bind-mounted host directories are never removed: clean up the last in
`afterDestroy`.
