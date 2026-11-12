---
description: Public origins - where a browser reaches each service, the PUBLIC_ORIGIN variable, footer links with urls, the publicOrigin option and the buildAddress helper.
---

# URLs and origins

Every service with a `port` has two addresses:

- **`http://localhost:<port>`**, where stackctl reaches it. Its `healthcheck` is probed here.
- **Its public origin**, where a browser reaches it. With a
  [reverse proxy](./reverse-proxy.md), that is its hostname there.

The public origin is what stackctl injects as `PUBLIC_ORIGIN`, what a path in `urls` is based
on, and what [`stackctl show-config`](../reference/cli.md#stackctl-show-config) reports as
`publicOrigin`.

## Which origin a service gets

| The service                                                    | Its public origin                                  |
| -------------------------------------------------------------- | -------------------------------------------------- |
| has no reverse proxy, or is in none of its routes               | `http://localhost:<port>`                          |
| is named by a route's `service`                                | `<scheme>://<subdomain>.<domain>[:port]`, from the first such route |
| is reached only through `'*'` or `paths`                       | none                                               |
| is an infra service in no route                                | none                                               |
| sets [`publicOrigin`](#publicorigin)                           | what that gives                                    |

A service reached only through `'*'` or `paths` has no host of its own, so stackctl doesn't
guess one: it gets no `PUBLIC_ORIGIN`, and a path in its `urls` is an error. Give it a
`publicOrigin`, or a `service` route of its own.

## `PUBLIC_ORIGIN`

Each service's process gets its public origin as `PUBLIC_ORIGIN`, next to `PORT`. Use it
wherever an app needs its own address: allowed hosts, CORS origins, OAuth callback URLs.

```ts
const origin = process.env.PUBLIC_ORIGIN; // https://api.myproject.test
```

`stackctl exec` and `stackctl run` set it too. Only a `PUBLIC_ORIGIN` in the service's own
`.env` file overrides it.

## Links in the footer

`urls` puts links on the terminal UI's links row. stackctl adds none of its own.

```ts
services: {
  web: {
    port: 3000,
    urls: [
      // the origin itself, shown as "web ↗"
      '',
      // a path on the origin, with a label
      { label: 'admin', url: '/admin' },
      // any URL, with a label
      { label: 'storybook', url: 'http://localhost:6006' },
      // a callback
      ({ port }) => `http://localhost:${port}/debug`,
    ],
  },
},
```

- **A path** is based on the service's public origin, so the same config is right with and
  without a proxy. It needs a `port`.
- **A link shows as `<label> ↗`.** Without a label of its own, it takes the service's name.
- **`urls` can itself be a callback** returning the list.
- **An infra service** takes the same `urls`.

The top-level `urls` option holds workspace-wide links that belong to no service, such as a
dashboard. A callback there gets `{ envs, tokens, buildAddress }`.

```ts
export default defineConfig({
  urls: [{ label: 'board', url: 'https://tracker.example.test/board' }],
  services: {/* … */},
});
```

## `publicOrigin`

- **Type:** `{ scheme?, subdomain?, domain?, port? } | (ctx) => …`

Sets a service's public origin part by part. Each part given replaces that part of the origin
it would otherwise have. Available on application and infra services.

```ts
reverseProxy: {
  port: 4000,
  publicAddress: { domain: 'example.test', scheme: 'https' },
  routes: [{ subdomain: '*', paths: { '/api/**': 'api', '/**': 'web' } }],
},
services: {
  // https://app.example.test
  web: { port: 3000, publicOrigin: { subdomain: 'app' }, urls: [''] },
  // https://example.test
  api: { port: 3001, publicOrigin: { subdomain: null } },
},
```

`subdomain: null` is the bare domain. A `port` that is the scheme's default is left out.

> [!WARNING]
> `publicOrigin` only shapes URLs. It never changes routing: for the proxy to serve `web` at
> `app.example.test`, a route has to send that host to it.

## `buildAddress`

`urls` and `healthcheck` callbacks, and infra callbacks, get `buildAddress`. It builds a URL
starting from the service's public origin, replacing the parts you pass:

```ts
web: {
  port: 3000, // routed at web.<domain>
  urls: ({ buildAddress }) => [
    // https://web.<domain>
    buildAddress(),
    // https://admin.<domain>
    buildAddress({ subdomain: 'admin' }),
    // https://<domain>/api
    buildAddress({ subdomain: null, path: '/api' }),
  ],
},
```

It takes `{ scheme?, subdomain?, domain?, port?, path? }`. For a service with no public
origin, and for the top-level `urls`, it starts from the proxy's
[public address](./reverse-proxy.md#publicaddress), or `http://localhost` without a proxy.

To build several links, make `urls` itself the callback, as above. A callback returned from a
`.map()` into the `urls` array gets no types from the config.
