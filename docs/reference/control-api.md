---
description: The localhost HTTP control API of a running session - finding its port, GET /query/status, GET /events, and the service, infra and quit commands, with request and response payloads.
---

# Control API

Every running session serves a small HTTP API on `127.0.0.1`. It is how a script, a test
suite or a coding agent reads the session's state and drives it: start, stop or restart a
service, wait until the stack is healthy, shut it down.

```bash
curl -s http://127.0.0.1:$port/query/status
curl -s -X POST http://127.0.0.1:$port/command/service/restart/api
```

Plain HTTP and JSON, no auth, loopback only. No endpoint takes a request body: everything is
in the path.

| Endpoint                                                          | What it does                               |
| ----------------------------------------------------------------- | ------------------------------------------ |
| [`GET /query/status`](#get-querystatus)                           | A snapshot of the session.                 |
| [`GET /events`](#get-events)                                      | The session's state as it changes.         |
| [`POST /command/service/<action>/<name>`](#post-commandservice)   | Start, stop or restart a service.          |
| [`POST /command/infra/<action>/<name>`](#post-commandinfra)       | Start, stop, restart or reset an infra service. |
| [`POST /command/quit`](#post-commandquit)                         | Shut the session down.                     |

From a shell, [`stackctl service`](./cli.md#stackctl-service) and
[`stackctl stop`](./cli.md#stackctl-stop) wrap the commands. From Node, use
[the client](#the-client).

## Finding the port

A free port is picked at startup and written to the mode's session record:

```
node_modules/.stackctl/modes/<mode>/running.json
```

```json
{
  "pid": 12345,
  "port": 14012,
  "sessionId": "1794164978752",
  "startedAt": 1794164978790,
  "logDir": "/repo/node_modules/.stackctl/modes/development/sessions/1794164978752",
  "logFile": "/repo/node_modules/.stackctl/modes/development/sessions/1794164978752/logs.txt",
  "children": [{ "pid": 12360, "cwd": "/repo/apps/api" }]
}
```

`children` lists the processes the session started, for the next session's cleanup. A session
deletes its record as it exits, but one killed outright leaves it behind. Check a
record before trusting it:

1. **No record, or its `pid` is gone:** no session.
2. **The `pid` is alive and `/query/status` on its `port` answers with the same `sessionId`:**
   that is the session.
3. **The `pid` is alive but the API doesn't answer as that session:** it looks hung, or the
   pid was reused.

```bash
record=node_modules/.stackctl/modes/development/running.json
field() { node --input-type=module -e "import r from './$record' with { type: 'json' }; console.log(r.$1)" 2>/dev/null; }
pid=$(field pid); port=$(field port); id=$(field sessionId)

if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "no session"
elif curl -s --max-time 2 "http://127.0.0.1:$port/query/status" | grep -q "\"sessionId\":\"$id\""; then
  echo "running on port $port"
else
  echo "pid $pid is alive but doesn't answer as the session"
fi
```

To use a fixed port instead, set [`apiPort`](../config/config-file.md#options) in the config.

## `GET /query/status`

Returns `200` with a snapshot. It answers from the moment the session starts, before any
service runs.

```jsonc
{
  "pid": 12345,
  "sessionId": "1794164978752",
  "configPath": "/repo/stackctl.config.ts",
  "mode": "development",
  "modeSource": "default",
  "startedByAgent": false,
  "logFile": "/repo/node_modules/.stackctl/modes/development/sessions/1794164978752/logs.txt",
  "services": { "web": "running", "api": "waiting" },
  "ready": { "web": true, "api": false },
  "infra": { "db": "running", "mail": "starting" },
  "sessionReady": false,
  "config": {/* the resolved config */},
  "reverseProxy": {
    "port": 4000,
    "domain": "localhost",
    "domains": ["localhost"],
    "routes": [{ "subdomain": ["api"], "service": "api" }]
  }
}
```

| Field            | Type              | What it is                                                                   |
| ---------------- | ----------------- | ---------------------------------------------------------------------------- |
| `pid`            | number            | The session's process.                                                       |
| `sessionId`      | string            | When the session started, in ms. Names its folder, as in its record.         |
| `configPath`     | string            | The config file it was started with.                                         |
| `mode`           | string            | The mode it runs in.                                                         |
| `modeSource`     | string            | Where the mode came from: `flag`, `env`, `ci` or `default`.                  |
| `startedByAgent` | boolean           | Whether a coding agent started it.                                           |
| `logFile`        | string            | The log file being written.                                                  |
| `services`       | object \| null    | Each service's status: `running`, `stopped`, `waiting` or `restarting`.      |
| `ready`          | object \| null    | Per service: `true` when running and passing its healthcheck, or running with none. |
| `infra`          | object \| null    | Each infra service's state: `running`, `starting`, `stopped`, `stopping`, `restarting` or `resetting`. `null` without infra. |
| `sessionReady`   | boolean           | `true` once every infra service is running and every service that isn't stopped is ready. |
| `config`         | object \| null    | The resolved config, as [`stackctl show-config`](./cli.md#stackctl-show-config) prints it. |
| `reverseProxy`   | object \| null    | The proxy's port, domains and routes. `null` without one.                    |

`services`, `ready` and `config` are `null` while the session is still bringing its infra up:
poll again, or follow [`/events`](#get-events). A configured service that isn't a key of
`services` is not part of this session. It can be [started](#post-commandservice) into it.

## `GET /events`

A long-lived response of newline-delimited JSON (`application/x-ndjson`): one object per
line, each with a `type`. The first line is the full snapshot, then each line of the mode's
[event log](./events.md) as it is written: by the session, or by another stackctl command.

```bash
curl -sN "http://127.0.0.1:$port/events"
```

```jsonc
{"type":"snapshot","pid":12345,"services":{"web":"waiting"},"ready":{"web":false},"infra":{"db":"starting"},"sessionReady":false, /* … */}
{"type":"infra-state","service":"db","status":"running","previousStatus":"starting", /* … */}
{"type":"service-state","service":"web","status":"running","ready":true,"previousStatus":"running","previousReady":false, /* … */}
{"type":"session-state","ready":true, /* … */}
{"type":"service-command","phase":"begin","id":"p81c","action":"restart","service":"web","by":{"kind":"control-api","request":"POST /command/service/restart/web","userAgent":"curl/8.7.1"}, /* … */}
{"type":"heartbeat","at":1792948269484}
```

| `type`        | Sent                                                          |
| ------------- | ------------------------------------------------------------- |
| `snapshot`    | First, once: everything `/query/status` returns.              |
| `heartbeat`   | Every 5 seconds: `at`, the session's clock in ms.             |
| anything else | A line of the event log: a state change (`service-state`, `infra-state`, `session-state`), a command, the session's own lifecycle. See [Events](./events.md). |

A client that switches on `type` ignores the ones it doesn't know. `snapshot` and `heartbeat` are
the stream's own, never in the file.

To wait until a stack is healthy, read until the session is ready or a service has stopped:

```bash
curl -sN "http://127.0.0.1:$port/events" \
  | grep -m1 -E '"sessionReady":true|"type":"session-state","ready":true|"status":"stopped"'
```

The stream ends when the session shuts down. If no line arrives for 15 seconds (three
heartbeats), treat the session as frozen.

## `POST /command/service`

```
POST /command/service/<action>/<name>
```

`<action>` is `start`, `stop` or `restart`. `<name>` is an application service.

| Action    | What it does                                                                     | Answers                        |
| --------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `start`   | Starts the service. One that isn't in the session is added, with the deps the session lacks. | `200` once started   |
| `stop`    | Stops it, and waits for its process to exit.                                     | `200` once stopped             |
| `restart` | Re-runs its dev command. Starts a stopped service.                               | `202` at once                  |

`start` and `stop` succeed for a service already in that state. A `restart` runs on in the
background: follow it on `/events`.

```bash
curl -s -X POST http://127.0.0.1:$port/command/service/restart/api
# {"ok":true}
```

| Status | Body                                                                                     | When                                        |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| `200`  | `{ "ok": true }`                                                                         | A `start` or `stop` finished.               |
| `202`  | `{ "ok": true }`                                                                         | A `restart` was accepted.                   |
| `404`  | `{ "ok": false, "error": "no service \"x\" in this session" }`                           | The name isn't in the config.               |
| `404`  | `{ "ok": false, "error": "unknown service action \"x\"" }`                               | The action isn't one of the three.          |
| `409`  | `{ "ok": false, "error": "service \"x\" is restarting" }`                                | A `start` or `stop` during a restart.       |
| `409`  | `{ "ok": false, "error": "service \"x\" has no dev command" }`                          | A `start` of a service with no dev script.  |
| `503`  | `{ "ok": false, "error": "service \"x\" could not be added: the session is shutting down" }` | A `start` during shutdown.              |
| `503`  | `{ "error": "manager not attached" }`                                                    | The session is still bringing its infra up. |

## `POST /command/infra`

```
POST /command/infra/<action>/<name>
```

`<action>` is `start`, `stop`, `restart` or `reset`. `<name>` is one of the session's
[infra services](../config/infra.md). These are the footer's `s`, `r` and `R` keys.

> [!WARNING]
> `reset` deletes the infra service's data, with no confirmation.

Every action answers at once and runs in the background. The service's `infra` state on
`/query/status` and `/events` shows it under way, then where it ended.

| Status | Body                                                                   | When                                    |
| ------ | ---------------------------------------------------------------------- | --------------------------------------- |
| `202`  | `{ "ok": true }`                                                       | Accepted.                               |
| `404`  | `{ "ok": false, "error": "no infra service \"x\" in this session" }`   | The session has no such infra service.  |
| `404`  | `{ "error": "unknown infra action \"x\"" }`                            | The action isn't one of the four.       |
| `409`  | `{ "ok": false, "error": "infra service \"x\" is busy" }`              | Another action on it is running.        |

## `POST /command/quit`

Shuts the session down gracefully, as Ctrl+C does. The request **blocks** until every service
has stopped and its port is free, then answers `200` with `{ "ok": true }`. That can take up
to about 15 seconds if a service is slow to exit.

```bash
curl -s -X POST http://127.0.0.1:$port/command/quit
```

Infra keeps running.

## Shutting down

Ctrl+C, `POST /command/quit`, `stackctl stop` and the signals `SIGINT`, `SIGTERM` and
`SIGHUP` all take the same path:

1. `SIGTERM` to each service's process group: the service and everything it spawned.
2. Up to 10 seconds for each to exit on its own.
3. `SIGKILL` to whatever is left.

A second Ctrl+C, or a second quit, during a shutdown skips the wait and kills at once.

> [!WARNING]
> Stop a session through the API, `stackctl stop` or Ctrl+C, never by killing its process. A
> session killed with `kill -9` can't clean up: its services keep running until the next
> session in that mode finds and stops them.

## The client

In Node, the same API is a typed client. [`startStack()`](./sdk.md#startstack) returns
one as `stack.control`, and an [infra callback](../config/infra.md#driving-the-session) gets
one as `control`.

| Method                                    | Endpoint                                | Resolves with                              |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `control.query.status()`                  | `GET /query/status`                     | The snapshot, or `null` if it didn't answer. |
| `control.events({ signal })`              | `GET /events`                           | An async iterator of the event objects: `SessionEvent`, the snapshot, the [event log's](./events.md) lines and the heartbeats. |
| `control.command.service.start(name)`     | `POST /command/service/start/<name>`    | `true` once started.                       |
| `control.command.service.stop(name)`      | `POST /command/service/stop/<name>`     | `true` once stopped.                       |
| `control.command.service.restart(name)`   | `POST /command/service/restart/<name>`  | `true` once accepted.                      |
| `control.command.infra.<action>(name)`    | `POST /command/infra/<action>/<name>`   | `true` once accepted.                      |
| `control.command.quit()`                  | `POST /command/quit`                    | Once the session has shut down.            |

A command resolves `false` when the session refused it. `events()` throws when the session
can't be reached or goes silent.
