import { defineConfig, logging } from 'stackctl';

export default defineConfig({
  // Handed to every callback as `tokens`; a service can add its own (see `backend`).
  tokens: { domain: 'example.test' },
  // Let `.env.development` extend an inherited NODE_OPTIONS instead of losing to it.
  env: { override: ['NODE_OPTIONS'] },
  // stackctl's own dev reverse proxy: http://<subdomain>.localhost:21050 reaches each service
  // (and the mail catcher), with a status page while it's stopped or starting. `tls: true` would
  // serve it over TLS too, with a self-signed certificate per hostname.
  reverseProxy: {
    port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT),
    // Where browsers reach it, and so every public origin. Omitted, it is this: localhost, http
    // (https with `tls: true`), on the proxy's own port. Behind a TLS terminator on 443 it would
    // be `{ domain: 'myproject.example.test', scheme: 'https' }`, and the URLs would carry no port.
    publicAddress: ({ envs }) => ({
      domain: 'localhost',
      scheme: 'http',
      port: Number(envs.DEV_REVERSE_PROXY_PORT),
    }),
    // Which service gets each request, like a Kubernetes ingress: the first entry whose subdomain
    // matches the host takes it.
    routes: [
      // The backend at http://api.localhost:21050, every path of it — its public origin.
      { subdomain: 'api', service: 'backend' },
      // An infra service is routed the same way: Mailpit's web UI at http://mail.localhost:21050.
      { subdomain: 'mail', service: 'mail' },
      // The frontend's own host, http://app.localhost:21050: its public origin, and so the
      // PUBLIC_ORIGIN its Vite config reads.
      { subdomain: 'app', service: 'frontend' },
      // Every other host — the bare http://localhost:21050, an unknown
      // http://foo.localhost:21050 — by path, the first glob that matches winning: /todos and
      // below to the backend, path unchanged, and everything else to the frontend.
      { subdomain: '*', paths: { '/todos/**': 'backend', '/**': 'frontend' } },
    ],
  },
  // Infrastructure that isn't an application service: the Postgres and the mail catcher in
  // ./docker-compose.yaml. `stackctl infra up` starts them and waits for their healthchecks;
  // `pnpm dev` does the same before starting the services, and leaves them running when you quit.
  // `infra: { 'docker-compose': {} }` alone would start both — `services` attaches callbacks, and
  // gives a service the port `reverseProxy.routes` reaches it on.
  infra: {
    'docker-compose': {
      services: {
        db: {
          // Once Postgres is healthy — on every `infra up` and every session start, including
          // when it was already running, so this has to be idempotent. `exec` executes a command
          // with the mode's environment (DATABASE_URI among it) and sends its output to stackctl.
          afterReady: async ({ exec, fresh }) => {
            await exec('node', ['src/migrate.ts'], { cwd: 'libs/db' });
            // `fresh`: this run created the database's volume — the very first start, or the
            // first after `stackctl infra destroy` / `infra up --reset`. Start from sample rows.
            if (fresh) {
              await exec('node', ['src/seed.ts'], { cwd: 'libs/db' });
            }
          },
        },
        // Mailpit's web UI, routed at http://mail.localhost:21050 like an application service.
        // `port` is the host side of its port mapping — stackctl doesn't read the compose file for
        // it.
        mail: {
          port: ({ envs }) => Number(envs.MAIL_UI_PORT),
          urls: [''], // `mail` in the footer links to its web UI
        },
      },
    },
  },
  // Each service lives at apps/<key> unless it sets `relativeDir` itself. (The libraries the
  // services import, in libs/, are plain pnpm `workspace:*` dependencies run as source, and not
  // part of this config.)
  serviceRootDir: 'apps',
  // Keyed by service name — what `-s` takes and what `deps` reference.
  services: {
    backend: {
      tokens: { region: 'us-east' },
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: '/health', // a path: probed at http://localhost:<port>/health
      urls: [
        '/todos', // a path: based on the public origin (http://api.localhost:21050/todos)
        { label: 'public', url: ({ tokens }) => `https://${tokens.region}.${tokens.domain}` },
      ],
    },
    worker: {
      // Go, via the Makefile's `start` target: recompiles on start, doesn't watch — restart after edits.
      command: ['start', { watches: false }],
      port: 3002,
      healthcheck: '/health',
      // Tune the default JSON-log formatting; the callback form varies the rules per entry.
      logs: {
        formatter: logging.formatter((log) => ({
          fields: {
            custom: {
              time: { show: false },
              ...(log.context === 'heartbeat' ? { port: { show: false } } : {}),
            },
          },
        })),
      },
    },
    frontend: {
      // At http://app.localhost:21050, and every path the bare http://localhost:21050 doesn't send
      // to the backend. Vite HMR rides the proxied connection (see vite.config.ts).
      port: 3000,
      // A longer probe deadline: a dev server compiling on first request can exceed the 1500ms default.
      healthcheck: { url: '/', timeout: 5000 },
      urls: [
        '', // '' is the public origin itself: http://app.localhost:21050
        // Any other address, from that origin with one part replaced: the bare
        // http://localhost:21050 (`subdomain: null` is the bare domain)…
        { label: 'root', url: ({ buildAddress }) => buildAddress({ subdomain: null }) },
        // …and http://mail.localhost:21050
        { label: 'inbox', url: ({ buildAddress }) => buildAddress({ subdomain: 'mail' }) },
      ],
      // Runs `backend` too, and waits for its healthcheck.
      deps: [{ service: 'backend', wait: true }],
    },
  },
});
