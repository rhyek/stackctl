# stackctl

Run your monorepo's stack in one terminal.

stackctl is a terminal UI and CLI for a monorepo's services, infrastructure, tests and CI
during development. You describe your services once, in a small typed config file. stackctl
starts the ones you pick and the services they need, brings up their infrastructure, loads
their environment, and shows it all in one place.

![stackctl's terminal UI running the example monorepo](https://raw.githubusercontent.com/rhyek/stackctl/main/docs/public/demo-1794401968.gif)

**Documentation: [stackctl.dev](https://stackctl.dev)**

## Features

- **One typed config.** `stackctl.config.ts` describes every service. Pick one and the
  services it needs come with it, started in order and held until they are healthy.
- **A terminal UI.** One combined, filterable log, with each service's state and memory in
  the footer. Drive it with the keyboard or the mouse.
- **Infra included.** Point it at your `docker-compose.yaml`: databases and brokers come up,
  get healthy and get migrated before your services start.
- **Environment handled.** Layered `.env` files per workspace, service and mode, injected into
  each process and reloaded when a file changes.
- **A hostname per service.** An optional dev reverse proxy, over TLS too, with a status page
  while a service starts.
- **The same stack in tests and CI.** `startStack()` for an e2e suite, `stackctl start --detach`
  for a CI job, in a mode that runs beside your dev session.
- **An SDK for scripts and tests.** `startStack()`, `exec()`, `run()` and `resolveEnv()` give your
  own code what the CLI gives a shell, typed and with the same environment.
- **Built for coding agents.** A headless mode, a localhost control API, an installable skill
  and `llms.txt`.
- **Any language.** A service is a `dev` script in `package.json` or a `Makefile` target.

## Install

```bash
pnpm add -D stackctl
pnpm stackctl init
```

Requires Node.js 26.12.1 or newer, on macOS or Linux.

## Quick start

```ts
// stackctl.config.ts
import { defineConfig } from 'stackctl';

export default defineConfig({
  serviceRootDir: 'apps', // each service lives at apps/<name>
  services: {
    api: {
      // read from api's .env files, and given to the process as PORT
      port: ({ envs }) => Number(envs.API_PORT),
      healthcheck: '/health',
    },
    web: {
      port: 3000,
      // selecting web also runs api, and holds web until api is healthy
      deps: [{ service: 'api', wait: true }],
    },
  },
});
```

Each service needs a `dev` script in its `package.json`, or a `dev` target in a `Makefile`.
Then:

```bash
pnpm stackctl                 # the terminal UI: pick services, run them
pnpm stackctl --headless -s web   # no UI: stream logs to stdout
pnpm stackctl run api seed    # one script, with api's environment
pnpm stackctl infra start     # start the infra, then exit
```

## Documentation

- [Getting started](https://stackctl.dev/guide/getting-started)
- [The config file](https://stackctl.dev/config/config-file)
- [CLI](https://stackctl.dev/reference/cli)
- [Control API](https://stackctl.dev/reference/control-api)
- [SDK](https://stackctl.dev/reference/sdk)
- [Built for agents](https://stackctl.dev/ai/overview)

A complete example monorepo is in [`example/`](https://github.com/rhyek/stackctl/tree/main/example).

For coding agents, the docs are indexed at [stackctl.dev/llms.txt](https://stackctl.dev/llms.txt),
and ship inside the package at `node_modules/stackctl/docs/llms.txt`.

## License

MIT
