---
description: Install stackctl, scaffold stackctl.config.ts, describe your services and run them.
---

# Getting started

stackctl runs a monorepo's services during development. You describe them once in a typed
config file; stackctl starts the ones you pick and the services they need, brings up their
infrastructure, loads their environment, and shows it all in one terminal UI.

The same config drives a headless mode for [tests and CI](./testing.md) and for
[coding agents](../ai/overview.md).

## Requirements

- **Node.js 26.12.1 or newer.**
- **macOS or Linux.** Windows is not supported.
- **Docker with Compose v2**, only if the config declares [infra](../config/infra.md).

## Install

::: code-group

```bash [pnpm]
pnpm add -D stackctl
```

```bash [npm]
npm install -D stackctl
```

```bash [yarn]
yarn add -D stackctl
```

:::

This installs two commands, `stackctl` and its short alias `sctl`. They are the same program.

stackctl sets the project up as it installs: in a project with no config, that is
`stackctl init --yes` (below). It is skipped in CI and never fails an install. pnpm runs a
dependency's install script only once you allow it: run `pnpm approve-builds`.

## Set up the project

```bash
pnpm stackctl init
```

`init` is interactive and safe to run again. It:

1. Asks which of the [agent guidance](../ai/overview.md#agent-guidance) to install: a rules
   file and a skill under `.claude/` (recommended), and a section of `AGENTS.md`.
2. Creates `stackctl.config.ts` at the repo root. An existing config is left alone.
3. Adjusts the root `tsconfig.json` so the config type-checks.

Pass `-y` to accept the defaults without questions.

## Describe your services

`stackctl.config.ts` is the one file you write and commit:

```ts
import { defineConfig } from 'stackctl';

export default defineConfig({
  serviceRootDir: 'apps', // each service lives at apps/<name>
  services: {
    api: {
      // read from api's .env files, and given to the process as PORT
      port: ({ envs }) => Number(envs.API_PORT),
      healthcheck: '/health', // probed at http://localhost:<port>/health
    },
    web: {
      port: 3000,
      // selecting web also runs api, and holds web until api is healthy
      deps: [{ service: 'api', wait: true }],
      // links in the footer
      urls: [
        // web's own address, shown as "web ↗"
        '',
        // a path on it
        '/docs',
        // any URL, with a label
        { label: 'storybook', url: 'http://localhost:6006' },
      ],
    },
  },
});
```

The key is the service's name. Most options take a plain value or, like `port` above, a
[callback](../config/config-file.md#callbacks) over the service's environment, so the config
can follow your `.env` files instead of repeating them.

Each service needs one thing in its own directory: a **`dev`**
script in its `package.json`, or a `dev` target in a `Makefile` for a service in another
language.

```jsonc
// apps/api/package.json
{
  "name": "api",
  "scripts": {
    "dev": "node --watch src/index.ts"
  }
}
```

See [Services](./services.md) for how a service is run, and [the config file](../config/config-file.md)
for every option.

## Run it

```bash
pnpm stackctl   # or its short alias: pnpm sctl
```

Pick the services to run, press `⏎`, and the [terminal UI](./terminal-ui.md) takes over: one
combined log, with every service's state in the footer.

<llm-exclude><TerminalPlayer src="/casts/getting-started-1794447139.cast" label="The run screen: the services' combined log, and the footer with each service's state, the keys and the links." still /></llm-exclude>
<llm-only>

```text
             ↑ 15 older lines — press Home to jump to oldest
19:32:04 [backend   ] todo api listening on http://localhost:3001
19:32:04 [frontend  ] backend ready, starting...
19:32:04 [frontend  ] started
19:32:05 [frontend  ]   VITE v8.3.5  ready in 786 ms
19:32:05 [frontend  ]   ➜  Local:   http://localhost:21060/
19:32:05 [frontend  ]   ➜  Network: use --host to expose
19:32:05 [frontend  ] 7:32:05 PM [vite] (ssr) connected.
── example ⎇ main ────────────────────────────────────────────────────────
● backend 65M   ● frontend 222M
infra: ● db 10M   ● mail 7M
←→ select   r restart   s stop   m commands
logs: f filter   c clear  │  ^c quit
backend ↗   public ↗   frontend ↗   root ↗   inbox ↗   mail ↗
```

</llm-only>

To skip the picker, name the services: `pnpm stackctl -s web`, or `pnpm sctl -s web`.

## A complete example

The [`example/`](https://github.com/rhyek/stackctl/tree/main/example) monorepo in the stackctl
repo is a small working project: a Node API, a Go worker run through a `Makefile`, a web
frontend, a Postgres database and a mail catcher from `docker-compose.yaml`, and the dev
reverse proxy in front. Its
[`stackctl.config.ts`](https://github.com/rhyek/stackctl/blob/main/example/stackctl.config.ts)
shows most options in use, with comments.

## Next steps

- [Why stackctl](./why.md): what it replaces.
- [Environment and modes](./env.md): `.env` files per service and per mode.
- [Infra](../config/infra.md): databases and other Compose services.
- [Tests and CI](./testing.md): the same stack for an e2e suite.
- [CLI reference](../reference/cli.md): every command and flag.
