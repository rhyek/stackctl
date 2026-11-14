---
description: The reverseProxy option - a dev reverse proxy that gives each service its own hostname, with routes by host and path, TLS, status pages, Vite HMR and a TLS terminator in front.
---

# Reverse proxy

stackctl can run the project's dev reverse proxy: one local port that routes each request to a
service by its hostname, then its path. Each service gets a real origin of its own instead of
a bare port:

```
http://localhost:3000   →   http://app.localhost:4000
http://localhost:3001   →   http://api.localhost:4000
```

Because stackctl knows every service's state, the proxy answers for one that is stopped or
still starting with a status page, not a connection error.

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  reverseProxy: {
    port: 4000,
    routes: [
      { subdomain: 'api', service: 'api' },
      { subdomain: 'app', service: 'web' },
    ],
  },
  services: {
    api: { port: 3001, healthcheck: '/health' },
    web: { port: 3000, urls: [''] },
  },
});
```

That is all it takes on `localhost`: browsers resolve every `*.localhost` name to the local
machine, so `http://app.localhost:4000` reaches the proxy with nothing else installed.

> [!TIP]
> `*.localhost` is resolved by browsers, not by the OS. With `curl`, pass the host yourself:
> `curl -H 'Host: api.localhost' http://127.0.0.1:4000/`.

## Options

| Option                            | Default                      | What it is                                             |
| --------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `port`                            | **required**                 | Where the proxy listens. A number or a callback.       |
| [`routes`](#routes)               | none                         | Which service gets each request.                       |
| [`publicAddress`](#publicaddress) | `localhost`, the proxy's port | Where browsers reach the proxy.                       |
| [`tls`](#tls)                     | `false`                      | Serve HTTPS on the same port.                          |

The block's presence enables the proxy. There is no `enabled` flag: remove the block to turn
it off. `port`, `publicAddress` and `tls` each take a callback over `{ envs, tokens }`.

Only a session runs the proxy. `stackctl exec`, `run` and `infra` never start it.

## `routes`

An ordered list, modelled on a Kubernetes ingress. Each entry has a `subdomain` and exactly
one of `service` or `paths`:

```ts
routes: [
  { subdomain: 'api', service: 'api' }, // api.<domain>, every path
  { subdomain: ['admin', 'backoffice'], service: 'admin' }, // either host
  { subdomain: 'mail', service: 'mail' }, // an infra service
  // every other host, the bare domain included, by path
  {
    subdomain: '*',
    paths: { '/docs/**': 'docs', '/api/**': 'api', '/**': 'web' },
  },
],
```

| Field       | What it is                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `subdomain` | A host under the domain: `'api'`, `'v2.api'`, or an array of them. `'*'` is every host no other entry names, the bare domain included, and its entry comes last. |
| `service`   | The service that gets every request on those hosts.                                               |
| `paths`     | Path globs to services, in [picomatch](https://github.com/micromatch/picomatch) syntax. The first glob that matches wins. |

A target is an application service or an [infra service](./infra.md#port-and-urls) with a
`port`. Names are type-checked.

**How a request is matched:**

1. The first entry whose `subdomain` matches the request's host handles it.
2. A `service` entry sends it to that service.
3. A `paths` entry sends it to the first glob its path matches. `/docs/**` matches `/docs` and
   `/docs/a/b`, not `/docsite`. The path reaches the service unchanged.
4. Anything else gets a 404 page listing the hosts that are routed. A request never falls
   through to a later entry.

A service named by a `service` entry gets that host as its
[public origin](./urls.md). One reached only through `'*'` or `paths` has none.

## `publicAddress`

- **Type:** `{ domain, scheme, port? } | (ctx) => …`
- **Default:** `{ domain: 'localhost', scheme: 'http', port: <the proxy's port> }`

Where browsers reach the proxy. Set it when something sits in front, such as a
[TLS terminator](#behind-a-tls-terminator) serving a real domain:

```ts
reverseProxy: {
  port: 4000,
  publicAddress: { domain: 'myproject.test', scheme: 'https' },
},
```

| Field    | What it is                                                                                  |
| -------- | ------------------------------------------------------------------------------------------- |
| `domain` | The domain the proxy routes by: requests must arrive with a `Host` under it.                |
| `scheme` | `'https'` or `'http'`: what browsers use.                                                   |
| `port`   | The port browsers use. Omit it for the scheme's default (443, 80).                          |

Beyond routing, it only shapes the URLs stackctl generates: each service's `PUBLIC_ORIGIN`,
footer links and `buildAddress`. It doesn't change how the proxy listens. Getting traffic for
that domain to the proxy is up to DNS or a terminator.

`domain` can be an array: the first entry is canonical, used in generated URLs, and the rest
are aliases that route the same way.

```ts
publicAddress: {
  domain: ['myproject.test', 'myproject.localhost'],
  scheme: 'https',
},
```

## `tls`

- **Type:** `true | { key, cert } | (ctx) => …`
- **Default:** `false`

Serves HTTPS on the proxy's port, beside plain HTTP. Browsers get HTTP/2, so a dev server's
hundreds of module requests share one connection.

```ts
reverseProxy: {
  port: 4000,
  tls: true, // https://app.localhost:4000
},
```

- **`true`** makes a self-signed certificate per hostname. The browser warns once for each:
  accept it. Open each hostname a page calls (the API's) once yourself too, or the browser
  silently refuses the page's requests to it. Certificates live in
  `node_modules/.stackctl/tls/`.
- **`{ key, cert }`** uses your own, each a file path or PEM text. For no warning at all, make
  one your browsers trust with [mkcert](https://github.com/FiloSottile/mkcert). Browsers
  reject `*.localhost` wildcards. `*.myproject.localhost` works.

Without a `publicAddress`, public origins become `https://`.

### Calls between services

A service calling another through the proxy would refuse a self-signed certificate. So with
`tls: true`, stackctl writes every certificate to one file and sets `NODE_EXTRA_CA_CERTS` to
it in each service's environment. Node trusts the proxy with no setup. Other runtimes can
read the same file:

| Runtime | How                                                                      |
| ------- | ------------------------------------------------------------------------ |
| Go      | Add it to the client's `tls.Config.RootCAs`.                             |
| Python  | `SSL_CERT_FILE`, and `REQUESTS_CA_BUNDLE` for requests.                  |
| Rust    | With reqwest, `Certificate::from_pem` and `add_root_certificate`.        |
| curl    | `--cacert "$NODE_EXTRA_CA_CERTS"`                                        |

## Status pages

Before forwarding, the proxy checks the service's state:

| The service is…                         | The response                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| running and ready                       | Forwarded. A refused connection is a **502** naming the service and port. |
| running, healthcheck not passing yet    | Held up to 15 s until it is ready, then forwarded. After that, a **503**. |
| stopped, waiting or restarting          | A **503** at once, saying so and how to start it.                         |
| not part of the session                 | Forwarded to its port anyway, so an app you run yourself is reachable.    |
| an infra service still coming up        | A **503**, `starting`.                                                    |
| an infra service disabled in this profile | A **503**, `disabled`.                                                  |

A 503 is an HTML page that refreshes itself, or JSON when the request doesn't accept HTML,
with `Retry-After`.

## WebSockets and Vite HMR

WebSocket upgrades are routed like any request, so Vite's HMR socket rides the same host and
port as the page. Point Vite at the service's injected `PUBLIC_ORIGIN`:

```ts
// vite.config.ts
const origin = new URL(process.env.PUBLIC_ORIGIN!);

export default defineConfig({
  server: {
    allowedHosts: [origin.hostname],
    hmr: { clientPort: Number(origin.port) || 443 },
  },
});
```

An upgrade to a service that isn't running is dropped, and the client reconnects on its own.

## Behind a TLS terminator

For a real domain on port 443, put anything that terminates TLS in front and forward to the
proxy's port. Tell stackctl with `publicAddress`:

```ts
reverseProxy: {
  port: 4000, // what the terminator forwards to
  publicAddress: { domain: 'myproject.test', scheme: 'https' },
},
```

With Caddy, one site block per project:

```
*.myproject.test, myproject.test {
  tls internal

  # WebSocket upgrades (Vite's HMR) stay on HTTP/1.1.
  @upgrade header Upgrade websocket
  reverse_proxy @upgrade 127.0.0.1:4000

  # Everything else is multiplexed over one HTTP/2 connection.
  reverse_proxy 127.0.0.1:4000 {
    transport http {
      versions h2c
      max_conns_per_host 1
    }
  }
}
```

The `h2c` transport matters: a dev server's page load is hundreds of requests at once, and
over HTTP/1.1 a terminator opens a connection for each, which can overflow the proxy's listen
queue on macOS and show up as 502s.

## What reaches the service

- **The `Host` header is kept as received**, so a signature computed over it (an S3 presigned
  URL) still matches.
- **Other headers pass through unchanged.** A request the proxy decrypts itself (`tls`) gains
  `X-Forwarded-Proto: https`, `X-Forwarded-Host` and `X-Forwarded-For`. A terminator's own
  `X-Forwarded-*` headers pass untouched.
- **Bodies stream both ways** with no buffering and no timeouts, so SSE and long-lived
  connections work.
- **The proxy does no auth.**
