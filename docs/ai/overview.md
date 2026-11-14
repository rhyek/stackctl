---
description: How stackctl is built for coding agents - the rules file and skill it offers to install, headless mode, the control API, llms.txt on the site and inside the npm package, and the guard rails that protect your session.
---

# Built for agents

A coding agent working in your repo needs what you need: the stack running, a way to restart
one service, the logs, the right environment for a script. stackctl gives an agent the same
tool you use, with an interface made for it.

| Piece                            | What the agent gets                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| [Agent guidance](#agent-guidance) | Knows when and how to use stackctl in this repo.                     |
| [Headless mode](#headless-mode)  | Runs the stack without a terminal UI.                                 |
| [The control API](#the-control-api) | Reads state and drives a running session over HTTP.                |
| [`llms.txt`](#llmstxt)           | These docs as Markdown, on the web and inside the package.            |

## What it looks like

Two real Claude Code conversations in the
[example workspace](https://github.com/rhyek/stackctl/tree/main/example), replayed with their
outputs folded as Claude Code folds them. The agent has the rules file and the skill stackctl
[offers to install](#agent-guidance), and nothing else.

**The app is down.** Someone restarted Postgres from another terminal, and the backend crashed.
The agent finds who in the [event log](../reference/events.md):

<llm-exclude><TerminalPlayer src="/casts/agent-restart-1794688512.cast" label="Claude Code finds the crashed backend, restarts it through stackctl and explains the crash" /></llm-exclude>
<llm-only>

```text
> the app isn't loading, can you check what's going on?

● Read(node_modules/stackctl/docs/llms.txt)
  ⎿  Read 47 lines

● Read(node_modules/stackctl/docs/ai/playbook.md)
  ⎿  Read 245 lines

● Bash(pnpm stackctl --profile development status)
  ⎿  development session: running since today 11:14:34 (pid 68544, contro…
     services  backend   running, not ready
               frontend  running, not ready
               worker    running, ready
     … +9 lines (ctrl+o to expand)

● Bash(pnpm stackctl --profile development logs | grep -iE
  'error|exception|fail|refused' | tail -30; pnpm stackctl --profile
  development events -n 30)
  ⎿  2026-11-12 11:14:41 [backend   ]     throw er; // Unhandled 'error' …
     2026-11-12 11:14:41 [backend   ] error: terminating connection due t…
     2026-11-12 11:14:41 [backend   ]     at parseErrorMessage (node_modu…
     2026-11-12 11:14:41 [backend   ] Emitted 'error' event on BoundPool …
     … +19 lines (ctrl+o to expand)

● Bash(pnpm stackctl --profile development service restart -s backend &&
  pnpm stackctl --profile development status)
  ⎿  restarting backend
     stackctl: waiting for backend to be healthy
     stackctl: everything is healthy
     development session: running since today 11:14:34 (pid 68544, contro…
     … +13 lines (ctrl+o to expand)

● The app is loading again: I restarted the backend and all three services
  now report healthy.

  Cause: the database was restarted at 11:14:40 (`infra restart -s db`,
  run from the CLI by a person). That cut the backend's Postgres
  connection with `terminating connection due to administrator command`.
  The backend crashed on an unhandled pg error. Its watch-mode dev script
  stayed alive waiting for a file change, so the service showed `running,
  not ready`. The frontend went not-ready because it depends on the
  backend.

  Fix: `stackctl --profile development service restart -s backend`.
  Backend, frontend and worker are now `running, ready`, and the db and
  mail infra are up.

  Underlying bug: the backend has no error handler on its pg pool, so any
  future database restart will crash it the same way. Adding a
  `pool.on('error', …)` handler, or reconnect logic, in the backend would
  fix that. I haven't changed any code. Want me to look at it?
```

</llm-only>

**Running the tests.** They call the backend, so the agent runs them against a test-profile
session of their own:

<llm-exclude><TerminalPlayer src="/casts/agent-tests-1794688538.cast" label="Claude Code starts a test-profile session, runs the backend's tests in it and stops it" /></llm-exclude>
<llm-only>

```text
> run the backend's tests

● Read(node_modules/stackctl/docs/llms.txt)
  ⎿  Read 47 lines

● Read(node_modules/stackctl/docs/ai/playbook.md)
  ⎿  Read 245 lines

● Bash(ls; ls .env* ; npx stackctl --profile test status; npx stackctl
  --profile development status; npx stackctl --profile test show-config |
  jq '.services | keys')
  ⎿  apps
     docker-compose.yaml
     libs
     node_modules
     … +25 lines (ctrl+o to expand)

● Test profile exists, no session running. Start a test session of the
  backend in the background.

● Bash(npx stackctl --profile test --headless -s backend)
  ⎿  Running in the background (↓ to manage)

● Bash(npx stackctl --profile test wait && npx stackctl --profile test run
  backend test)
  ⎿  stackctl: waiting for backend to be healthy
     stackctl: everything is healthy
     test session ready: pid 66053, control API on 14045, log node_module…
     ✔ lists the todos (81.360709ms)
     … +10 lines (ctrl+o to expand)

● Bash(npx stackctl --profile test stop)
  ⎿  stopped test session (pid 66053)

● All 3 backend tests passed:

  - lists the todos
  - rejects a todo without a title
  - adds a todo, completes it and deletes it

  I ran them in stackctl's `test` profile. I started a test session for
  the backend, ran `stackctl --profile test run backend test`, then
  stopped the session. The development session wasn't running, and I
  didn't touch it.
```

</llm-only>

## Agent guidance

The first time you start a session in a terminal, stackctl asks once:

```
◆  Tell coding agents about stackctl in this repo? (a rules file and a skill under .claude/)
│  ● Yes / ○ No
```

Both are a few lines that say what stackctl runs here and point at the [index](#llmstxt) inside
the installed package, so an agent reads the page it needs, for the version you have. Without
them an agent does what it would in any repo: `kill` whatever holds a port, run a bare
`docker compose`, run the test script outside a session.

- **Nothing is installed unasked.** A no is remembered, and an agent, a script or CI is never
  asked. [`stackctl init -y`](../reference/cli.md#stackctl-init) installs them from a script.
- **They stay current.** A newer stackctl refreshes a copy you haven't edited.
- **For other agents**, `stackctl init --agents-md` adds the same lines to `AGENTS.md`.

## Headless mode

```bash
stackctl --headless -s web
```

The same session as the terminal UI, without the UI: logs stream to stdout, and the process
runs until it is told to quit. An agent runs it as a background task, waits for it with
`stackctl wait`, and stops it with `stackctl stop` when done. See
[Start a stack](./playbook.md#start-a-stack).

For an e2e suite, [`startStack()`](../guide/testing.md) gives the test runner a stack that
ends with the test run.

## The control API

Every session serves a [localhost HTTP API](../reference/control-api.md). It answers the
questions an agent would otherwise guess at:

```bash
curl -s http://127.0.0.1:$port/query/status                           # what is running, and is it healthy
curl -sN http://127.0.0.1:$port/events                                # tell me when that changes
curl -s -X POST http://127.0.0.1:$port/command/service/restart/api    # restart one service
```

It works on a session **you** started too. An agent can restart the API in the terminal UI
you have open, and you see it happen in your log:

```
16:41:22 [control ] [INFO] restart
16:41:22 [control ]   service: api
```

Every command that changes the stack, from a key, the control API or a stackctl command, is
written to the session's [event log](../reference/events.md) with who asked, and `/events` streams
it. `stackctl status` shows the last ones, so an agent asked why something broke can see what was
done to it, and by whom.

Without a session, [`stackctl show-config`](../reference/cli.md#stackctl-show-config) prints
every service's resolved port and URL as JSON, so an agent never has to guess a port from a
`.env` file.

## `llms.txt`

The docs follow the [llms.txt](https://llmstxt.org/) convention, generated from the same
Markdown as this site:

| URL                                   | What it is                                           |
| ------------------------------------- | ---------------------------------------------------- |
| `https://stackctl.dev/llms.txt`       | An index: one line per page, with a description.     |
| `https://stackctl.dev/llms-full.txt`  | Every page in one file.                              |
| `https://stackctl.dev/<page>.md`      | Any page as Markdown: add `.md` to its URL.          |

The same index and pages ship **inside the npm package**:

```
node_modules/stackctl/docs/llms.txt
node_modules/stackctl/docs/guide/…
node_modules/stackctl/docs/config/…
```

That copy matches the installed version, works offline, and is what the
[agent guidance](#agent-guidance) points at. The index opens by sending an agent to the
[playbook](./playbook.md), which has the rules and a recipe for each task.

## Guard rails

An agent shares the machine with you, so stackctl draws a few lines:

- **An agent can't take over your session.** Starting a second session in a profile quits the
  first. stackctl allows that between two agent-started sessions, and refuses it when a person
  started the running one. See
  [Taking over a running session](../reference/cli.md#taking-over-a-running-session).
- **An agent can't leave a session behind.** `--detach` is refused for an agent outside CI. A
  session an agent starts runs in its own background task and ends with it.
- **An agent always names the profile.** A command an agent runs without `--profile` is refused,
  so it never acts on your development session when it meant its own test one.
- **Graceful stops only.** The playbook tells agents to stop and restart with stackctl
  (`stackctl stop`, `stackctl service restart`), never with `kill`.
- **Data is deleted only on request.** `infra reset` and `infra destroy` are documented
  to agents as destructive.

stackctl recognizes an agent by the environment variables agents set (`CLAUDECODE`,
`CURSOR_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX`, `AGENT`, …). A session reports it as
`startedByAgent` on `/query/status`.

## For the agent

The [agent playbook](./playbook.md) is the page written for the agent itself: short recipes
for the tasks above.
