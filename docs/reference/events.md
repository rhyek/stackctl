---
description: The event log - each session's record of what acted on its stack (keys, control API requests, stackctl commands) and what the session did (starts, exits, readiness), one JSON object per line, in node_modules/.stackctl/profiles/<profile>/sessions/<id>/events.jsonl and on GET /events.
---

# Events

Each session keeps an event log: what acted on its stack, and what the session did, one JSON
object per line.

```bash
stackctl status         # the session now, and the last commands that acted on it
stackctl events -n 20   # the last 20 lines
stackctl events -f      # and follow them
```

Each session has its own file,
`node_modules/.stackctl/profiles/<profile>/sessions/<id>/events.jsonl`, in the folder that holds
[its log](../guide/logs.md#log-files). The control API's [`GET
/events`](./control-api.md#get-events) streams the same lines as they are written.

```jsonc
{"type":"infra-command","phase":"begin","id":"56de9f1a","action":"restart","requested":["db"],"by":{"kind":"cli","argv":["infra","restart","-s","db"],"cwd":".","agent":false},"time":"2026-11-11T13:22:12.255-06:00","profile":"development","sessionId":"1794424917144","pid":91514}
{"type":"infra-state","service":"db","status":"stopped","previousStatus":"running", /* … */}
{"type":"service-state","service":"backend","status":"running","ready":false,"previousStatus":"running","previousReady":true, /* … */}
{"type":"infra-command","phase":"end","id":"56de9f1a", /* … */ "ok":true,"durationMs":2249,"services":["db"],"results":{"db":"ready"}, /* … */}
```

- **What changes the stack is written; what reads it never is.** `status`, `wait`, `logs`,
  `show-config`, `events`, `GET /query/status` and Compose's read-only commands (`ps`, `logs`,
  `config`, `top`, …) leave no line.
- **Whatever does it writes it:** the session for its keys, its control API and itself; a stackctl
  command for itself, whether a session runs or not.
- **A command run between sessions** goes in the latest session's file: a folder holds its
  session and what came after it, until the next one starts.
- **Kept 7 days**, with the session's folder. Over 5 MB, the next line starts a new file and the
  old one becomes `events.1.jsonl`. `stackctl reset` deletes every session's.
- **Arguments as given, a URL's password masked** (`postgres://app:***@…`). No environment
  value is written.

## Every line

`type` comes first and decides the rest. Its own fields follow, and every line ends with:

| Field       | What it is                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| `time`      | When, ISO 8601 with the machine's offset, to the millisecond.               |
| `profile`   | The profile.                                                                |
| `sessionId` | The profile's running session, as `/query/status` names it, or `null`.      |
| `pid`       | The process that wrote the line.                                            |

Paths are relative to the workspace root. A reader ignores a `type` it doesn't know.

## State

What something is now, written by the session when it changes, with what it was (`null` the
first time).

| `type`          | Fields                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `service-state` | `service`, `status`, `ready`, `previousStatus`, `previousReady`              |
| `infra-state`   | `service`, `status`, `previousStatus`                                        |
| `session-state` | `ready`: every service that isn't stopped ready, every infra service running |

A service's `status` is `running`, `waiting`, `restarting` or `stopped`. A dev script that watches
its files, such as `node --watch`, outlives the app it runs: when the app crashes the service stays
`running`, and its `ready` turns `false`.

## Commands

Something asked stackctl to act. Each command writes two lines with the same `id`: `phase`
`begin` with what was asked, then `end` with `ok`, `durationMs` and what came of it. A `begin` with
no `end` is a command still running, or one whose process was killed.

| `type`            | Asked                                                                       | `end` adds                    |
| ----------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `service-command` | `action` (`start`, `stop`, `restart`), `service`                            | `outcome`: `done`, `busy`, `waiting`, `unknown`, `unavailable` |
| `infra-command`   | `action` (`start`, `stop`, `restart`, `reset`, `destroy`), `requested` (`[]` for all) | `services`, `results` (each `ready`, `stopped`, `destroyed` or `failed`), `everything`, `error` |
| `compose-command` | `args`: what followed `infra docker-compose`                                | `exitCode`                    |
| `one-off-command` | `kind` (`exec`, `run`), `service` or `dir`, `command`, or `script` and `args` | `exitCode`, `signal`        |
| `session-command` | `action` (`quit`, `reset`)                                                  |                               |

- **A `restart` ends** when the service has been started again. Whether it got ready follows in
  `service-state` lines.
- **A `quit` ends** when the session's services are down, just before its `session-end`.
- **A `reset`'s lines open** the new file, since the reset deleted the old one.
- **An `exec` or `run` inside a command stackctl runs writes no line**, such as one in a
  service's dev script. The outer command is the one recorded.

Every command says who asked in `by`:

| `by.kind`     | Fields                                    | Who                                                   |
| ------------- | ----------------------------------------- | ----------------------------------------------------- |
| `ui`          | `key`: `r`, `s`, `R`, `m` or `^c`         | A person at the terminal UI.                          |
| `control-api` | `request` (`POST /command/…`), `userAgent` | A control API request: `curl/8.7.1`, or `stackctl/<version>` from a stackctl command (`service`, `stop`, a takeover). |
| `cli`         | `argv`, `cwd`, `agent`                    | A stackctl command run in a shell: its arguments, where it ran, and whether a coding agent ran it. |
| `sdk`         | `argv`, `cwd`, `agent`                    | A Node script calling [`exec()` or `run()`](./sdk.md#exec-and-run): the script and its arguments, where it ran, and whether a coding agent ran it. |
| `session`     |                                           | The session itself: bringing its infra up as it starts. |

A session's infra keys and its control API's infra requests run `stackctl infra <action>` as a
command of its own, which writes the lines with the key or request that asked.

## Lifecycle

What the session does on its own.

| `type`          | Fields                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `session-start` | `services`, `headless`, `startedByAgent`, `argv`, `version`, `logFile`, `replaced`: the `sessionId` it took over, or `null` |
| `session-end`   | `cause` (`quit`, `signal`, `error`), `durationMs`                          |
| `service-exit`  | `service`, `exitCode`, `signal`: its process exited, and stackctl hadn't stopped it |
| `env-change`    | `dir`: where a `.env` file changed, `services`: the ones it restarts       |
