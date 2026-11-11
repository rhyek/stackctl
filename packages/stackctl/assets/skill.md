---
name: stackctl
description: Use when you need to know whether an app, service, or dev server in this repo is currently running or already started — e.g. "is the backend up?", or before launching one yourself — INCLUDING when you don't yet know whether stackctl (also run as `sctl`) manages that app, or whether this repo uses stackctl at all (the docs cover how to tell, and how to check an app stackctl does not manage); when you need to reach an application service or a proxied infra service (an object store, a mail catcher's web UI) — find the URL, hostname, port, or public origin an app or API is served at, to call it with curl or fetch, open it in a browser, or point another service at it (never guess a port or hostname: `stackctl show-config` prints the resolved ones); when starting, stopping, or restarting a local dev service through stackctl, or starting a dev stack in the background and waiting for it to be healthy (`stackctl --headless` as a background task, waited on with `GET /events`, or `startStack()` from a test runner's global setup), or writing a CI workflow that starts one (`stackctl start --detach`); when running a one-off command or a `package.json` script in a service's directory with its environment (`stackctl exec`, `stackctl run`, or `exec()`/`run()` from a script); when you need the project's local infrastructure — a database, cache, broker, or any other Docker Compose service — started, stopped, reset, or inspected, or before running `docker compose` yourself in this repo (stackctl binds Compose to a per-mode project, so a bare `docker compose` lands on the wrong one: use `stackctl infra`); when asked to add, configure, or onboard a service into stackctl; when you need to know whether a service needs a restart after changing its code; when a script of your own needs the values the workspace's `.env` files give a mode, or a service's exact environment (`resolveEnv`); when choosing which `.env` files load, or adding a project's own around stackctl's (`--mode`, `env.additionalFiles`); or when debugging a running service by reading its logs.
---

# stackctl

stackctl runs a monorepo's local dev services: it starts the ones asked for with the services
they need, brings up their infrastructure, and loads their environment. It can be run
headlessly, driven over an HTTP API, taught about new services, and queried for logs while a
session runs.

> **Stop and restart sessions through the control API — never `kill`, `pkill`, or
> `lsof … | kill` a stackctl process or its port.** To stop a running session,
> `POST /command/quit` (to the API port in `node_modules/.stackctl/modes/<mode>/running.json`,
> e.g. `modes/development/running.json`); it shuts
> every service down gracefully and frees the ports — that's all you need before relaunching. To
> restart one service in place without stopping the session, `POST /command/service/restart/<name>`
> (or `stackctl service restart -s <name>`).
> Reaching for a raw OS kill is a mistake: it kills the process out from under stackctl and
> looks like the session "died" on its own.

If you need to **reach a service** — its URL, hostname, or port, to `curl` it or open it — run
`stackctl show-config` (no session needed) and read that service's `publicOrigin` (the hostname it
is served at, via stackctl's dev reverse proxy) or its `port` on localhost. The playbook's _"Reach
a service"_ section says which to use and how. Never guess a port or hostname.

If you need the project's **database or other infrastructure** — to start it, reset it, or look
at it — use `stackctl infra` (`start`, `stop`, `restart`, `reset`, `destroy`, and
`docker-compose <args>` for Compose itself), never a bare `docker compose`: stackctl puts the mode
in the Compose project name, so a bare command talks to a different, empty project. `infra reset`
and `infra destroy` delete data — only on request. `config/infra.md` has the details.

If all you need is **whether an app is already running**, read the playbook's _"Is it running?"_
section — it covers how to tell whether stackctl manages that app in the first place, how to read
a live session's per-service state, and how to check an app stackctl doesn't manage. Do it before
starting anything: a new session takes over from (and shuts down) a running one.

The docs ship inside the installed `stackctl` package, so they always match the version in
`node_modules`: an index, `llms.txt`, with one line per page, and each page as Markdown beside it.

**Read these two now, before acting**, with the Read tool:

```
${CLAUDE_PROJECT_DIR}/node_modules/stackctl/docs/ai/playbook.md
${CLAUDE_PROJECT_DIR}/node_modules/stackctl/docs/llms.txt
```

The playbook has the recipes: checking what is running, reaching a service, starting a stack in
the background, driving a session, one-off commands, infra, logs, onboarding a service. The index
lists every other page (configuration, CLI, control API, SDK) with what it covers: read the
page a task needs, by its path in the index, relative to `node_modules/stackctl/docs/`.

Those should already read as absolute paths. If they still show an unresolved placeholder, your
harness does not substitute them — read `node_modules/stackctl/docs/ai/playbook.md` resolved from
the repository root instead, NOT from this skill's own directory, which has no `node_modules`
under it.

Nothing loads the docs for you. Those paths are deliberately not `@` references: `@` force-loads
a whole file, which defeats the progressive disclosure a skill exists to provide. If you have not
run Read, you have not seen them.
