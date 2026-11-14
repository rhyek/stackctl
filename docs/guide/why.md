---
description: What stackctl replaces in a monorepo's development setup, and what it deliberately leaves alone.
---

# Why stackctl

A monorepo with a few services takes a ritual to start. A terminal per service. A
`docker compose up` you have to remember. An order that matters, because the frontend fails
until the API answers. `.env` files loaded a different way by each service. Then a second
version of all of it for the e2e suite, a third for CI, and a fourth explained to a coding agent
in a prompt.

stackctl replaces the ritual with one config file and one command.

## One description, used everywhere

`stackctl.config.ts` says what the services are, what each one needs, and how to tell it is
ready. Everything else reads that file:

| You want to…                     | Run                                                        |
| -------------------------------- | ---------------------------------------------------------- |
| Work on the app                  | `stackctl`, the [terminal UI](./terminal-ui.md)            |
| Run a migration or a seed script | [`stackctl run api seed`](./commands.md)                   |
| Give an e2e suite a stack        | [`startStack()`](./testing.md) in its global setup         |
| Start the stack in a CI job      | [`stackctl start --detach`](./testing.md#in-ci)            |
| Let a coding agent drive it      | [`stackctl --headless`](../ai/overview.md) and the control API |

They all get the same services, in the same order, with the same environment.

## What it takes care of

- **Start order and readiness.** A service's `deps` run with it, and a dep with `wait: true`
  holds it until that service's healthcheck passes.
- **Infrastructure.** The databases and brokers in your `docker-compose.yaml` come up first,
  wait until healthy and run your migrations. See [Infra](../config/infra.md).
- **Environment.** Layered `.env` files per workspace, service and profile, injected into each
  process, with the affected services restarted when a file changes. See
  [Environment and profiles](./env.md).
- **Logs.** Every service in one stream you can filter, with JSON logs formatted for reading
  and a log file per session. See [Logs](./logs.md).
- **Isolation between profiles.** `stackctl --profile test` is a second session with its own
  ports, containers and state, next to the one you are working in.
- **Hostnames.** An optional [dev reverse proxy](../config/reverse-proxy.md) puts each service
  on its own host, with a status page while it is down.
- **Clean exits.** Quitting stops every service it started, and a second `stackctl` in the same
  project takes over from the first instead of fighting it for ports.

## What it leaves alone

- **Your dev scripts.** stackctl runs each service's own `dev` script as written. Watching
  files and reloading stays with the tool that already does it (Vite, `node --watch`, `air`).
- **Your build.** It builds nothing. How a service compiles, bundles or imports shared code is
  up to its own dev script.
- **Your Compose file.** Images, ports, volumes and healthchecks stay in `docker-compose.yaml`.
  stackctl runs Compose for you and adds per-profile projects and callbacks around it.
- **Production.** It is a development tool. Nothing in it deploys or serves real traffic.
