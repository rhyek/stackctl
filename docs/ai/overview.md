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

<llm-exclude><TerminalPlayer src="/casts/agent-restart-1794445754.cast" label="Claude Code finds the crashed backend, restarts it through stackctl and explains the crash" /></llm-exclude>
<llm-only>

```text
> the app isn't loading, can you check what's going on?

● Skill(stackctl)
  ⎿  Launching skill: stackctl

● Read(node_modules/stackctl/docs/llms.txt)
  ⎿  Read 47 lines

● Read(node_modules/stackctl/docs/ai/playbook.md)
  ⎿  Read 243 lines

● Bash(pnpm stackctl status)
  ⎿  development session: running since today 19:04:23 (pid 72629, contro…
     services  backend   running, not ready
               frontend  running, not ready
               worker    running, ready
     … +16 lines (ctrl+o to expand)

● Bash(pnpm stackctl show-config | jq '.services | map_values({ port,
  publicOrigin, healthcheck })')
  ⎿  {
       "backend": {
         "port": 3001,
         "publicOrigin": "http://api.localhost:21050",
     … +22 lines (ctrl+o to expand)

● Backend and frontend are running but not ready, and db was restarted
  right after the session started. Checking logs.

● Bash(pnpm stackctl logs | grep -iE 'error|exception|ECONN|fail' | tail
  -30; echo ---; pnpm stackctl logs | tail -25)
  ⎿  2026-11-11 19:05:12 [backend   ]     throw er; // Unhandled 'error' …
     2026-11-11 19:05:12 [backend   ] error: terminating connection due t…
     2026-11-11 19:05:12 [backend   ]     at parseErrorMessage (node_modu…
     2026-11-11 19:05:12 [backend   ] Emitted 'error' event on BoundPool …
     … +36 lines (ctrl+o to expand)

● The backend crashed when the db was restarted. I'll restart it with
  stackctl, which is the recipe for this case.

● Bash(pnpm stackctl service restart -s backend; pnpm stackctl status |
  head -6)
  ⎿  restarting backend
     stackctl: waiting for backend to be healthy
     stackctl: everything is healthy
     development session: running since today 19:04:23 (pid 72629, contro…
     … +5 lines (ctrl+o to expand)

● The app was down because the backend crashed, and it's now fixed. All
  three services (backend, frontend, worker) are running and ready.

  Cause: at 19:05:12 someone ran `stackctl infra restart -s db`, which
  restarted the database. The backend's Postgres pool got `terminating
  connection due to administrator command`. It had no handler for that
  error, so the process crashed. The dev script then sat on "Waiting for
  file changes before restarting…", so the backend stayed "running" but
  never came back. The frontend stayed not-ready because it depends on the
  backend.

  Fix: I ran `stackctl service restart -s backend`. It came back healthy
  and the frontend followed.

  Follow-up: the backend will crash again on any future database restart
  or dropped connection. The fix is an `error` listener on the pg Pool
  (`pool.on('error', …)`) so a dropped idle connection doesn't throw as an
  unhandled event. I haven't changed any code. Do you want me to add that
  handler?
```

</llm-only>

**Running the tests.** They call the backend, so the agent runs them against a test-mode session
of their own:

<llm-exclude><TerminalPlayer src="/casts/agent-tests-1794445787.cast" label="Claude Code starts a test-mode session, runs the backend's tests in it and stops it" /></llm-exclude>
<llm-only>

```text
> run the backend's tests

● Read(node_modules/stackctl/docs/llms.txt)
  ⎿  Read 47 lines

● Read(node_modules/stackctl/docs/ai/playbook.md)
  ⎿  Read 243 lines

● Read(node_modules/stackctl/docs/guide/testing.md)
  ⎿  Read 101 lines

● Following the playbook: find the config, test mode and service names.

● Bash(ls -a && npx stackctl show-config | jq '.services |
  map_values({port, command})' && npx stackctl --mode test status)
  ⎿  .
     ..
     .claude
     .env
     … +52 lines (ctrl+o to expand)

● No test session is running, so I'll start one for the backend in the
  background.

● Bash(npx stackctl --mode test --headless -s backend)
  ⎿  Running in the background (↓ to manage)

● Bash(cat node_modules/.stackctl/modes/test/running.json)
  ⎿  {
       "port": 14059,
       "pid": 75771,
       "sessionId": "a20d4bad-8bdf-45ec-8388-562f43124103",
     … +10 lines (ctrl+o to expand)

● Bash(timeout 120 curl -sN "http://127.0.0.1:14059/events" | grep -m1 -E
  '"sessionReady":true|"type":"session-state","ready":true|"status":"stopped"')
  ⎿  {"type":"snapshot","pid":75771,"sessionId":"a20d4bad-8bdf-45ec-8388-…

● Ready. Running the tests in the test mode's environment.

● Bash(npx stackctl --mode test run backend test)
  ⎿  ✔ lists the todos (61.719875ms)
     ✔ rejects a todo without a title (14.42275ms)
     ✔ adds a todo, completes it and deletes it (20.679625ms)
     ℹ tests 3
     … +7 lines (ctrl+o to expand)

● Tests passed. Stopping the test session.

● Bash(curl -s -X POST http://127.0.0.1:14059/command/quit)
  ⎿  {"ok":true}

● All 3 backend tests passed: lists the todos, rejects a todo without a
  title, and adds, completes and deletes a todo.

  I ran them in stackctl's `test` mode, which has its own ports and
  database, so your development data wasn't touched. No test session was
  running beforehand, so I started one for the backend, ran `stackctl
  --mode test run backend test`, and then quit the session.
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
runs until it is told to quit. An agent runs it as a background task, waits for it on the
control API, and stops it when done. See
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
written to the mode's [event log](../reference/events.md) with who asked, and `/events` streams
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

- **An agent can't take over your session.** Starting a second session in a mode quits the
  first. stackctl allows that between two agent-started sessions, and refuses it when a person
  started the running one. See
  [Taking over a running session](../reference/cli.md#taking-over-a-running-session).
- **An agent can't leave a session behind.** `--detach` is refused for an agent outside CI. A
  session an agent starts runs in its own background task and ends with it.
- **Graceful stops only.** The playbook tells agents to stop and restart through the control API,
  never with `kill`.
- **Data is deleted only on request.** `infra reset` and `infra destroy` are documented
  to agents as destructive.

stackctl recognizes an agent by the environment variables agents set (`CLAUDECODE`,
`CURSOR_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX`, `AGENT`, …). A session reports it as
`startedByAgent` on `/query/status`.

## For the agent

The [agent playbook](./playbook.md) is the page written for the agent itself: short recipes
for the tasks above.
