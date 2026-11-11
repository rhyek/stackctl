---
description: What a service is to stackctl, the dev script or Makefile target it runs, how scripts are executed, and restarting after a code edit.
---

# Services

A service is a long-running dev process: an API, a frontend, a worker. To stackctl it is a
directory with a **dev entry point**, plus a key in `stackctl.config.ts`.

## The dev script

stackctl looks in the service's directory:

- **With a `package.json`**, it runs the `dev` script.
- **With a `Makefile` and no `package.json`**, it runs `make dev`.

That is how a Node service and a Go service sit side by side:

```jsonc
// apps/api/package.json
{
  "name": "api",
  "scripts": {
    "dev": "node --watch src/index.ts"
  }
}
```

```makefile
# apps/worker/Makefile
.PHONY: dev
dev:
	@go run .
```

A service's other scripts (`build`, `test`, `seed`, …) are not part of its lifecycle. They show
up in the terminal UI's [commands menu](./terminal-ui.md#keys), and
[`sctl run`](./commands.md) runs one from a shell.

To run a script with another name, set [`command`](../config/services.md#command):

```ts
worker: { command: 'start' }, // runs the `start` script or target
```

## After a code edit

stackctl does not watch your source. Whether a service picks up an edit depends on its own dev
script, and `command` says which kind it is:

| `command`                         | The dev script…                 | After you edit its code               |
| --------------------------------- | ------------------------------- | ------------------------------------- |
| `'dev'` (the default)             | watches files and reloads       | nothing to do                         |
| `['start', { watches: false }]`   | runs once, from current source  | restart it                            |

Restart a service with `r` in the terminal UI, `sctl service restart -s <name>`, or
`POST /command/service/restart/<name>` on the [control API](../reference/control-api.md).
`watches` changes nothing about how the service runs: it tells you, and a
[coding agent](../ai/playbook.md#after-editing-code), whether a restart is needed.

An edit to a service's `.env` files is different: stackctl watches those and
[restarts the service itself](./env.md#live-reload).

## Dependencies

`deps` lists the services that run alongside this one. Add `wait: true` to hold it until that
service's healthcheck passes:

```ts
services: {
  api: { port: 3001, healthcheck: '/health' },
  web: { port: 3000, deps: [{ service: 'api', wait: true }, 'worker'] },
  worker: {},
}
```

Selecting `web` runs `api` and `worker` too, and `web` starts once `api` is healthy. See
[`deps`](../config/services.md#deps).

## How a script is run

stackctl runs a `package.json` script itself: the script's text goes to `/bin/sh` in the
service's directory, with no package manager in between. A Makefile target runs as
`make <name>`.

- **`PATH`** starts with the service's `node_modules/.bin`, then each parent directory's, so a
  script can name a binary installed in the service or at the workspace root.
- **The environment** is the service's resolved [`.env` files](./env.md), its `PORT`, and the
  usual `npm_package_name`, `npm_lifecycle_event` and `INIT_CWD`.
- **`pre<name>` and `post<name>` scripts are not run.** Put the step in the script:
  `"dev": "node codegen.ts && vite dev"`.
- **Package manager script settings have no effect** (pnpm's `scriptShell`, `shellEmulator`, …).
- **Exit codes** are reported as they are. A script killed by a signal reports 128 plus the
  signal number (`137` for `SIGKILL`).

## Shared code

A library several services import is not a service, and is not in the stackctl config:
stackctl never builds or runs it. How services import shared code is up to the project. An
edit to a library reaches a service the way an edit to its own code does: its dev script picks
it up, or the service is restarted.
