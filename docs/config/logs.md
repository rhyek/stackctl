---
description: The logs options of stackctl.config.ts - on-screen timestamps, the default JSON log formatter, the logging helpers for pino and winston, and writing your own formatter.
---

# Logs

The `logs` option controls how output is shown. It exists at the top level and per service.
Most projects never set it: timestamps are on, and JSON logs are
[formatted by default](../guide/logs.md#json-logs-are-formatted-for-you).

```ts
import { defineConfig, logging } from 'stackctl';

export default defineConfig({
  logs: { timestamps: true }, // top level: the default for every service
  services: {
    api: { logs: { formatter: logging.nodejs.pino.formatter() } },
    worker: { logs: { timestamps: false } },
  },
});
```

| Option                              | Where                  | What it does                                   |
| ----------------------------------- | ---------------------- | ---------------------------------------------- |
| [`timestamps`](#timestamps)         | top level, per service | Shows or hides the time on each on-screen line. |
| [`formatter`](#formatter)           | per service            | Replaces the default log formatter.            |

## `timestamps`

- **Type:** `boolean`
- **Default:** `true`

Whether on-screen lines carry a timestamp. A service's own value wins over the top-level one.
The log file always has timestamps.

## `formatter`

- **Type:** `(line: string) => string`
- **Default:** `logging.formatter()`

Called with each line of the service's output. It returns the text to show.

The default passes plain text through and renders a JSON log as `[LEVEL] message`, with the
remaining fields indented below. Replace it with one of the `logging` helpers to adjust that
rendering, or with [a function of your own](#writing-your-own) for any other format.

## The `logging` helpers

Each builds a formatter for **JSON logs**. A line that isn't a recognized JSON log passes
through untouched.

| Helper                                     | For                                                         |
| ------------------------------------------ | ----------------------------------------------------------- |
| `logging.formatter(config?)`               | The default. Go `slog`, and anything with string levels.    |
| `logging.nodejs.pino.formatter(config?)`   | pino and bunyan: maps their numeric levels (`30` → `INFO`). |
| `logging.nodejs.winston.formatter(config?)` | winston: reads its `message` key and level names.          |

`config` is optional:

```ts
logging.formatter({
  fields: {
    level: 'severity', // the JSON key holding the level. Default: 'level'
    message: 'text', // the JSON key holding the message. Default: 'msg'
    custom: {
      time: { show: false }, // hide a field
      timestamp: 'ts', // show the field `ts` as `timestamp`
    },
  },
  levels: { 5: 'error' }, // map a numeric or custom level to a name
});
```

Pass a callback instead to decide per log entry. It receives the parsed log:

```ts
logging.formatter((log) => ({
  fields: {
    custom: {
      time: { show: false },
      // `port` is noise on the heartbeat that repeats every 5 s
      ...(log.context === 'heartbeat' ? { port: { show: false } } : {}),
    },
  },
}));
```

### Levels

A string level is matched to `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` or `FATAL`, ignoring
case and folding common aliases (`WARNING`, `ERR`, `CRITICAL`, `NOTICE`, …), and colored by
severity.

A numeric level is never guessed, because the numbers aren't standard: pino's `30` is INFO,
Python's is WARNING. It shows as `[UNKNOWN LOGLVL: 30]` until `levels` maps it, which the pino
helper does for you.

## Writing your own

A formatter is just a function over the raw line, so it works for output that isn't JSON:

```ts
worker: {
  logs: {
    formatter: (line) => line.replace(/^\[worker-\d+\] /, ''),
  },
},
```

- **Return the line unchanged** to leave it as it was: plain for stdout, red for stderr.
- **ANSI colors are allowed.** They are stripped for the log file.
- **A multi-line result** becomes several log lines that stay together as one entry, so a
  filter matching any of them shows the whole block.
- **Don't print a time.** stackctl stamps each line itself.
- **A formatter that throws** falls back to the raw line.
