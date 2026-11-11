---
description: stackctl.config.ts - where it lives, every top-level defineConfig option, callbacks, typed tokens, splitting the config across files and typed service names.
---

# The config file

stackctl reads one file, `stackctl.config.ts`, at the root of the workspace. It is ordinary
TypeScript: your editor completes every option and flags a misspelled service name.

```ts
import { defineConfig } from 'stackctl';

export default defineConfig({
  serviceRootDir: 'apps',
  services: {
    api: { port: 3001, healthcheck: '/health' },
    web: { port: 3000, deps: [{ service: 'api', wait: true }] },
  },
});
```

The **workspace** is the nearest directory, at or above the one you run `stackctl` in, that
holds the config (`.ts`, `.mts`, `.js` or `.mjs`), so every command works from anywhere in the
repo.

## Options

| Option           | What it is                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `services`       | Your application services, keyed by name. **Required.** See [Services](./services.md).              |
| `serviceRootDir` | The directory services live under, e.g. `'apps'`: each service is at `<serviceRootDir>/<name>`. **Recommended.** Without it, every service sets `relativeDir`. |
| `env`            | Variables of the config's own, and how `.env` files load. See [Environment](./env.md).              |
| `logs`           | On-screen timestamps. See [Logs](./logs.md).                                                        |
| `infra`          | Databases, caches and other Docker Compose services. See [Infra](./infra.md).                       |
| `reverseProxy`   | A dev reverse proxy with a hostname per service. See [Reverse proxy](./reverse-proxy.md).           |
| `urls`           | Workspace-wide footer links, not tied to a service. See [URLs and origins](./urls.md#links-in-the-footer). |
| `tokens`         | Values of your own, handed to every callback. See [Tokens](#tokens).                                |
| `apiPort`        | Pins the [control API](../reference/control-api.md)'s port. By default a free one is picked. A pinned port serves one mode's session at a time. |
| `workspaceDir`   | The root that service directories resolve against. Defaults to the config file's directory, and is rarely set. |

## Callbacks

stackctl does no string interpolation: a `$` in a config string is a `$`. A value that depends
on the environment is a plain function of it instead, which your editor type-checks.

```ts
services: {
  api: {
    port: ({ envs }) => Number(envs.API_PORT),
    healthcheck: '/health', // a path needs no callback: it is probed on the service's port
    urls: [{ label: 'debug', url: ({ port }) => `http://localhost:${port + 1}` }],
  },
},
```

Most options take a literal or a callback. A service's callbacks get one object:

| Key            | What it is                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `envs`         | The environment the service gets: its resolved [`.env` files](../guide/env.md) and the shell's. |
| `tokens`       | The top-level `tokens`, with the service's own merged over them.                               |
| `service`      | `{ name, kind }`, and for `healthcheck` and `urls` also `port`, `route` and `publicOrigin`.    |
| `port`         | `healthcheck` and `urls` only: the service's port, as a `number`.                              |
| `buildAddress` | `healthcheck` and `urls` only: builds a URL from the service's origin. See [`buildAddress`](./urls.md#buildaddress). |

Workspace-level callbacks (`env.vars`, `reverseProxy.port`, the top-level `urls`) belong to no
service and get `{ envs, tokens }`.

- **Callbacks are synchronous and run once**, when the config loads. Restart stackctl to pick
  up a changed value.
- **Reading `port` in a callback of a service with no `port`** is an error at load, naming the
  service.
- **Infra callbacks are the exception**: `beforeStart`, `afterReady` and the others are async
  and run on every `infra start`. See [Infra callbacks](./infra.md#callbacks).

## Tokens

`tokens` are named values for your callbacks, typed from what you write. A service's own
`tokens` are merged over the top-level ones, and are private to that service:

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  tokens: { domain: 'example.test' },
  services: {
    api: {
      tokens: { region: 'us-east' },
      // tokens is { domain, region }: tokens.regoin would not compile
      urls: [({ tokens }) => `https://${tokens.region}.${tokens.domain}`],
    },
    web: {}, // tokens is { domain }
  },
});
```

Closing over an ordinary `const` in the config file works just as well.

## Inspecting the result

[`stackctl show-config`](../reference/cli.md#stackctl-show-config) prints the fully resolved
config as JSON, with no session running: callbacks run, defaults applied, every port and URL
filled in.

```bash
stackctl show-config | jq '.services | map_values({ port, publicOrigin })'
stackctl show-config --mode test
```

The config's default export is that same resolved object, so another script can import it:

```ts
import config from './stackctl.config.ts';

config.services.api.port; // number | undefined
```

## Splitting the config across files

A part of the config can live in its own file and still be checked where it is written. Use
`satisfies` with one of these types:

| Type                                           | For                                             |
| ---------------------------------------------- | ----------------------------------------------- |
| `ServiceInput<Names>`                          | one application service                         |
| `InfraServiceInput`                            | one infra service                               |
| `InfraServicesInput`                           | a provider's `services` map                     |
| `ReverseProxyRoute<Names>`                     | one `reverseProxy.routes` entry                 |
| `ReverseProxyInput`, `DockerComposeInfraInput` | a whole `reverseProxy` or provider block        |

```ts
// infra/queue.ts
import type { InfraServiceInput } from 'stackctl';

export const queue = {
  afterReady: async ({ envs, log }) => {
    log(`queue admin on ${envs.QUEUE_ADMIN_PORT}`);
  },
} satisfies InfraServiceInput;
```

```ts
// stackctl.config.ts
import { defineConfig } from 'stackctl';
import { queue } from './infra/queue.ts';

export default defineConfig({
  serviceRootDir: 'apps',
  services: { api: {}, worker: {} },
  infra: { 'docker-compose': { services: { db: {}, queue } } },
});
```

Node loads the config directly, so its files import each other by their real `.ts` name. Set
`allowImportingTsExtensions` in `tsconfig.json` for the type checker.

`Names` is the union of service names the part may refer to (`'api' | 'web'`). Use
`satisfies`, not a type annotation: an annotation widens the part's names to `string`, and
`defineConfig` can no longer check them.

## Typed service names

Optional. To use your service names as a type in other scripts, name the config value and
register it:

```ts
const config = defineConfig({/* … */});
export default config;

declare module 'stackctl' {
  interface Register {
    serviceConfigs: typeof config.services;
    infraServices: typeof config.infra; // leave out without infra
  }
}
```

`ServiceName`, `InfraServiceName` and `ServiceConfig<'api'>`, imported from `stackctl`, are
then your own names and types, and `startStack()`'s `origins` is keyed by them.

## `--workspace-dir`

The `--workspace-dir <dir>` flag (and `workspaceDir` in the [SDK](../reference/sdk.md))
names the directory holding the config, to run stackctl against a workspace from outside it.
It is not the config's `workspaceDir` option above.
