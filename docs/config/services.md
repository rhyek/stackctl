---
description: Every option of a service in stackctl.config.ts - port, healthcheck and readiness, deps, command, urls, autostart, tokens, logs, color and directory.
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
    },
    web: {
      port: 3000,
      deps: [{ service: 'api', wait: true }],
      urls: [''],
    },
    worker: {
      command: ['start', { watches: false }],
      autostart: false,
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
| [`relativeDir`](#relativedir)   | `<serviceRootDir>/<name>` | The service's directory.                       |
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
service and the env files that were read. Only a `PORT` in the service's own `.env` file
overrides the injected one.

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

`deps` can be a callback over `{ mode, envs, tokens }`, resolved once per session, for a dep
that only runs in some modes:

```ts
api: {
  deps: ({ mode }) =>
    mode === 'test' ? ['gateway'] : ['codegen', 'gateway'],
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
the terminal UI, `stackctl service start -s <name>`, or the control API. A service that waits
for it waits until you do.

## `selectable`

- **Type:** `boolean`
- **Default:** `true`

Set `false` to hide a service from the picker. It still runs as another service's dep, or with
`-s`.

## `relativeDir`

- **Type:** `string`
- **Default:** `<serviceRootDir>/<name>`

The service's directory, relative to the workspace. Set it for a service that lives somewhere
else. It is required when the config has no `serviceRootDir`.

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
