---
description: How stackctl is built for coding agents - the installable skill, headless mode, the control API, llms.txt on the site and inside the npm package, and the guard rails that protect your session.
---

# Built for agents

A coding agent working in your repo needs what you need: the stack running, a way to restart
one service, the logs, the right environment for a script. stackctl gives an agent the same
tool you use, with an interface made for it.

| Piece                            | What the agent gets                                                   |
| -------------------------------- | --------------------------------------------------------------------- |
| [The skill](#the-skill)          | Knows when and how to use stackctl in this repo.                      |
| [Headless mode](#headless-mode)  | Runs the stack without a terminal UI.                                 |
| [The control API](#the-control-api) | Reads state and drives a running session over HTTP.                |
| [`llms.txt`](#llmstxt)           | These docs as Markdown, on the web and inside the package.            |

## The skill

`stackctl init` offers to install an agent skill:

```
.claude/skills/stackctl/SKILL.md
```

It is also written under `.agents/` and `.cursor/` when those directories exist. The skill is
short on purpose. Its description tells the agent when stackctl is relevant: "is the backend
up?", "restart the API", "run the migration", "what URL is the app on?". Its body points at
the docs that ship inside the installed package, so the agent reads the page it needs, for the
version you have.

The file is managed by stackctl: installing a newer stackctl, or starting a session with one,
refreshes a copy you haven't edited. A copy you edited is left alone, and `stackctl init`
rewrites it.

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

That copy matches the installed version, works offline, and is what the skill reads. To point
any other agent at it, add a line to your `AGENTS.md` or `CLAUDE.md`:

```md
This repo runs its dev services with stackctl. Its docs are indexed at
node_modules/stackctl/docs/llms.txt.
```

## Guard rails

An agent shares the machine with you, so stackctl draws a few lines:

- **An agent can't take over your session.** Starting a second session in a mode quits the
  first. stackctl allows that between two agent-started sessions, and refuses it when a person
  started the running one. See
  [Taking over a running session](../reference/cli.md#taking-over-a-running-session).
- **An agent can't leave a session behind.** `--detach` is refused for an agent outside CI. A
  session an agent starts runs in its own background task and ends with it.
- **Graceful stops only.** The skill tells agents to stop and restart through the control API,
  never with `kill`.
- **Data is deleted only on request.** `infra up --reset` and `infra destroy` are documented
  to agents as destructive.

stackctl recognizes an agent by the environment variables agents set (`CLAUDECODE`,
`CURSOR_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX`, `AGENT`, …). A session reports it as
`startedByAgent` on `/query/status`.

## For the agent

The [agent playbook](./playbook.md) is the page written for the agent itself: short recipes
for the tasks above.
