---
description: The combined log stream - filtering, timestamps, automatic JSON log formatting, stackctl's own lines, log files and the stackctl logs command.
---

# Logs

Every service's output goes into one stream, each line labelled with its service:

```
13:53:32 [api     ] listening on 3001
13:53:32 [web     ] VITE ready in 431 ms
13:53:33 [worker  ] [INFO] job picked up
13:53:33 [worker  ]   id: 42
```

Every label is padded to the longest one the session can show (its services, its infra
services and stackctl's own), so every line's text starts in one column. A service added
mid-session widens them all.

stderr lines are red. In the terminal UI, `/` filters the stream by any text, ignoring case and
accents: type a service's name to see only that service. The terms are highlighted in the lines
shown.

## JSON logs are formatted for you

Plain text passes through untouched. A line that is a JSON log (Go's `slog`, pino, winston)
is shown as a colored `[LEVEL] message`, with its other fields listed below:

```
{"time":"2026-07-13T13:53:32Z","level":"INFO","msg":"listening","port":3002}
```

```
[INFO] listening
  time: 2026-07-13T13:53:32Z
  port: 3002
```

So a service can log JSON in every environment, with no `NODE_ENV` branch in its logger. There
is nothing to configure. To map numeric levels, hide a field or format non-JSON output, see
[the `logs` options](../config/logs.md).

## Timestamps

Each line is stamped with the local time. The terminal UI adds the date only when two days are
on screen together. Turn the stamps off on screen with
[`logs.timestamps`](../config/logs.md#timestamps). The log file always has them.

## stackctl's own lines

stackctl writes to the same stream, in gold, under labels of its own:

| Label              | What it logs                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| `[stackctl]`       | The session: its profile, why each dependency runs, startup failures, shutting down. |
| `[control]`        | Commands received over the [control API](../reference/control-api.md).             |
| `[infra]`          | Docker Compose's output.                                                           |
| `[infra:<service>]` | One [infra service](../config/infra.md)'s output, its callbacks included.         |

```
16:41:20 [stackctl] [INFO] api: runtime dep of web
16:41:22 [control ] [INFO] restart
16:41:22 [control ]   service: api
```

## Log files

Every session writes its whole stream to a file, timestamps included, colors removed, in a
folder of its own named by when it started:

```
node_modules/.stackctl/profiles/<profile>/sessions/<id>/
  logs.txt        the session's log
  events.jsonl    its event log (see below)
  commands/       a log per sctl exec and sctl run
```

- **A one-off command belongs to the latest session**, running or not: its log goes in that
  folder's `commands/`. It holds the command, its piped output and how it ended; output that
  went to a terminal isn't in it. See [Output and exit code](./commands.md#output-and-exit-code).
- **A session's folder is kept for 7 days**, then deleted when a session starts.

## Reading a session's log

From another terminal, without disturbing the session:

```bash
sctl logs                 # print the current session's log
sctl logs -f              # print it, then follow new lines
sctl logs --path          # print only the file's path
sctl logs --profile test  # the test session's
```

Ctrl+C stops the following, never the session. The following also stops when the next session
starts, since that one has a log of its own. With no session running, it shows the last one's log. See [`sctl logs`](../reference/cli.md#stackctl-logs).

## What acted on the session

The log holds what the services print. What acted on them, a key pressed, a control API request,
a `sctl infra restart` from another terminal, goes to the session's
[event log](../reference/events.md) instead, with who did it:

```bash
sctl status       # the session now, and the last commands
sctl events -f    # every line, as it is written
```
