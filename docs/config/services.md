---
description: Every option of a service in stackctl.config.ts - port, healthcheck and readiness, deps, command, urls, autostart, tags, its own env files and variables, tokens, logs, color and directory.
---

# Services

`services` is an object keyed by service name. The key is the name: what `-s` takes, what
`deps` refer to, and the directory under `serviceRootDir`. There is no `name` field.

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  services: {
    api: {
      port: ({ envs }) => Number(envs.API_PORT),
      healthcheck: '/health',
      tags: ['backend'],
    },
    web: {
      port: 3000,
      deps: [{ service: 'api', wait: true }],
      urls: [''],
      tags: ['browser'],
    },
    worker: {
      command: ['start', { watches: false }],
      autostart: false,
      tags: ['backend'],
    },
  },
});
```

Every option is optional. `{}` is a valid service: it runs the `dev` script in
`<serviceRootDir>/<name>`.

| Option                          | Default               | What it does                                       |
| ------------------------------- | --------------------- | -------------------------------------------------- |
| [`port`](#port)                 | none                  | The dev port, given to the process as `PORT`.      |
| [`healthcheck`](#healthcheck)   | none                  | A URL polled to tell when the service is ready.    |
| [`deps`](#deps)                 | none                  | Services that run with this one.                   |
| [`command`](#command)           | `'dev'`               | The script to run, and whether it watches files.   |
| [`urls`](#urls)                 | none                  | Links shown in the footer.                         |
| [`autostart`](#autostart)       | `true`                | Whether it starts with the session.                |
| [`selectable`](#selectable)     | `true`                | Whether the picker lists it.                       |
| [`tags`](#tags)                 | `[]`                  | Labels for picking services together.              |
| [`dir`](#dir)                   | `<serviceRootDir>/<name>` | The service's directory.                       |
| [`env`](#env)                   | the config's          | `.env` files, variables and overrides of its own.  |
| [`tokens`](#tokens)             | none                  | Values for this service's callbacks.               |
| [`logs`](#logs)                 | inherits              | Timestamps and log formatting for this service.    |
| [`color`](#color)               | assigned              | The color of its log label.                        |
| [`publicOrigin`](#publicorigin) | from its route        | Where a browser reaches it, set part by part.      |

## `port`

- **Type:** `number | (ctx) => number | undefined`

The port the dev process listens on. stackctl injects it as `PORT`, uses it for `healthcheck`
and `urls` paths, and frees it when taking over from an earlier session.

```ts
api: { port: 3001 },
// from the service's .env files
web: { port: ({ envs }) => Number(envs.WEB_PORT) },
```

A callback that returns `NaN`, the usual sign of a missing variable, is an error naming the
service and the env files that were read. Only a `PORT` in a `.env` file in the service's own
directory overrides the injected one.

## `healthcheck`

- **Type:** `string | (ctx) => string | { url, timeout }`

A URL stackctl polls while the service runs. Once it answers, the service is **ready**: its
dot turns green, and services that wait for it start.

```ts
api: { port: 3001, healthcheck: '/health' },
web: { port: 3000, healthcheck: { url: '/', timeout: 5000 } },
```

- **A path** (`'/health'`) is probed at `http://localhost:<port>/health`: always the service
  itself, never the reverse proxy.
- **`timeout`**, in milliseconds, is how long one probe may take. The default is `1500`. Raise
  it for a service slow to answer on a cold start, such as a dev server that compiles on its
  first request.
- **Probing** starts moments after the service does and backs off to one probe every couple
  of seconds.

A service with no `healthcheck` counts as ready as soon as it is running.

## `deps`

- **Type:** `Array<string | { service, wait? }> | (ctx) => Array<…>`

The services that run alongside this one. Selecting `web` below also runs `api` and `worker`:

```ts
web: { deps: [{ service: 'api', wait: true }, 'worker'] },
```

- **`wait: true`** holds this service until that one's `healthcheck` passes. The service
  waited for must have a `healthcheck`.
- **Names are type-checked** against the keys of `services`.
- **Deps are not transitive.** Only the services you select have their deps run. If `api` needs
  `auth`, list `auth` in `web`'s deps too, or select `api`.

`deps` can be a callback over `{ profile, envs, tokens }`, resolved once per session, for a dep
that only runs in some profiles:

```ts
api: {
  deps: ({ profile }) =>
    profile === 'test' ? ['gateway'] : ['codegen', 'gateway'],
},
```

## `command`

- **Type:** `string | [string, { watches?: boolean }]`
- **Default:** `['dev', { watches: true }]`

The `package.json` script or Makefile target to run as the dev process, and whether it watches
files and reloads on its own.

```ts
worker: { command: ['start', { watches: false }] },
```

`watches` doesn't change how the service runs. It records whether a restart is needed after a
code edit. See [After a code edit](../guide/services.md#after-a-code-edit).

## `urls`

- **Type:** `Array<string | { label, url } | (ctx) => string> | (ctx) => Array<…>`

Links on the footer's links row.

```ts
web: {
  port: 3000,
  urls: [
    '',
    '/admin',
    { label: 'storybook', url: 'http://localhost:6006' },
  ],
},
```

A path is based on the service's [public origin](./urls.md), and `''` is the origin itself.
See [Links in the footer](./urls.md#links-in-the-footer).

## `autostart`

- **Type:** `boolean`
- **Default:** `true`

Set `false` to leave a selected service stopped when the session starts. Start it with `s` in
the terminal UI, `stackctl service start -s <service>`, or the control API. A service that waits
for it waits until you do.

## `selectable`

- **Type:** `boolean`
- **Default:** `true`

Set `false` to hide a service from the picker. It still runs as another service's dep, or with
`-s` or `-t`.

## `tags`

- **Type:** `string[]`
- **Default:** `[]`

```ts
services: {
  api: { tags: ['backend', 'data'] },
  worker: { tags: ['backend'] },
  web: { tags: ['frontend'] },
}
```

Labels for picking services together with `-t, --tag`. An empty tag is an error, and a repeated
one counts once. Each resolved service carries its tags, so your own code can select by them,
in a script that imports the config and runs from the workspace root:
`Object.values(config.services).filter((s) => s.tags.includes('backend'))`.

## `dir`

- **Type:** `string`
- **Default:** `<serviceRootDir>/<name>`

The service's directory: relative to the workspace, or absolute. Set it for a service that
lives somewhere else. It is required when the config has no `serviceRootDir`.

- **It must be inside the workspace.** One outside fails when the config loads.
- **It decides which `.env` files load**: those of every directory from the root down to it.
  See [Which files load](../guide/env.md#which-files-load).

## `env`

- **Type:** `{ inherits?, vars?, override?, additionalFiles? } | (ctx) => vars`

`.env` files, variables and overrides for this service alone, on top of the config's
[`env`](./env.md):

```ts
api: {
  env: {
    vars: { LOG_LEVEL: 'debug' },
    override: ['NODE_OPTIONS'],
    additionalFiles: [{ file: '.env.api', after: '.env' }],
  },
},
```

Each option works as its namesake in the config's [`env`](./env.md), for this service only.
`inherits` decides what happens to the config's:

| Option            | `inherits: true` (default)              | `inherits: false` |
| ----------------- | --------------------------------------- | ----------------- |
| `vars`            | Merged over the config's, its own win.  | Its own only.     |
| `override`        | Added to the config's.                  | Its own only.     |
| `additionalFiles` | Loaded after the config's.              | Its own only.     |

- **A callback stands for `vars`**: `env: ({ envs }) => ({ … })`. Its `envs` holds the service's
  `.env` files and the config's `vars` when it inherits, and its `tokens` are the service's.
- **It reaches the service everywhere**: its process, its callbacks (`port`, `urls`, …), and
  [`stackctl exec` and `run`](../guide/commands.md#naming-a-service) on it. A directory
  that is no service gets the config's `env` alone.
- **`decrypt` is the config's**, and applies to every service either way.
- **A file the config's `additionalFiles` lists** is an error here, unless `inherits: false`.
- **It shows in the resolved config**: `stackctl show-config` prints each service's result as
  `envFiles`, `envOverride` and `envVars`, so don't compose a secret in `vars`.

## `tokens`

- **Type:** `Record<string, string>`

Values for this service's callbacks, merged over the top-level `tokens`. See
[Tokens](./config-file.md#tokens).

## `logs`

- **Type:** `{ timestamps?: boolean, formatter?: (line: string) => string }`

Per-service log options. See [Logs](./logs.md).

## `color`

- **Type:** `string`

The color of the service's log label: a name (`'magenta'`), a hex (`'#af87ff'`),
`'rgb(175,135,255)'` or `'ansi256(140)'`. By default each service gets a color from a palette.

## `publicOrigin`

- **Type:** `{ scheme?, subdomain?, domain?, port? } | (ctx) => …`

Overrides parts of the service's public origin, the URL in its `PUBLIC_ORIGIN`. See
[`publicOrigin`](./urls.md#publicorigin).

## Service names

A name must not be an integer-like string (`'2'`): JavaScript reorders such keys, which would
change the start order. An application service and an [infra service](./infra.md) can't share
a name.
