// stackctl's structured-log formatting. `logging.formatter(config)` builds the formatter used for
// a service's output; **a default `logging.formatter()` is applied to every service automatically**
// (override per service with `logs.formatter`). Each output line is parsed as JSON; non-JSON lines
// (and JSON that isn't an object with a recognizable level/message) are returned untouched. A
// recognized log renders as a `[LEVEL] message` header — the `[LEVEL]` colored by severity — with
// the remaining properties listed, indented, on the lines below. stackctl splits that multi-line
// result into separate log lines and groups the indented ones with the header as continuations.

import chalk from 'chalk';
import { LOG_LEVEL_COLORS, LOG_PROPERTY_KEY_COLOR } from './colors.js';

/** Long-form config for a custom (renamed and/or hidden) property in {@link FormatterFields.custom}. */
export interface CustomField {
  /** Property name in the source JSON log. Defaults to the custom entry's key (its display name). */
  source?: string;
  /** Whether to print the property. Defaults to `true`. */
  show?: boolean;
}

/**
 * The `custom` mapping: keyed by the **display** name, each entry is either the source field name
 * (string shorthand) or a long-form {@link CustomField}.
 */
export type CustomFields = Record<string, string | CustomField>;

/** One resolved custom entry: the name to print it under, and whether to print it at all. */
type CustomEntry = { display: string; show: boolean };

/** The source JSON field mapping — `config.fields` of {@link FormatterConfig}. */
export interface FormatterFields {
  /**
   * Source JSON property holding the log level. Defaults to `'level'` — the key both Go's
   * `log/slog` and Node's pino emit. A **string** level is uppercased and matched to stackctl's
   * canonical levels (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`; e.g. `WARNING` → `WARN`);
   * an unmatched string, or a **number** with no {@link FormatterConfig.levels} map, prints as
   * `[UNKNOWN LOGLVL: …]`.
   */
  level?: string;
  /** Source JSON property holding the message. Defaults to `'msg'`. (winston uses `message`.) */
  message?: string;
  /**
   * Rename or hide additional properties, keyed by the **display** name:
   * - `{ timestamp: 'ts' }` — show the source field `ts` under the name `timestamp`.
   * - `{ timestamp: { source: 'ts' } }` — long form of the above.
   * - `{ time: { show: false } }` — hide the `time` field (source defaults to the key).
   */
  custom?: CustomFields;
}

/**
 * Config for {@link createFormatter} / `logging.formatter` — how to read and display **one JSON
 * log object per line**. Everything here describes the *source JSON*: which keys hold the level and
 * message, how to translate level values, and which properties to rename or hide.
 */
export interface FormatterConfig {
  /** Source JSON field mapping (level/message keys, property rename/hide). */
  fields?: FormatterFields;
  /**
   * Convert raw level *values* to level names — needed for numeric levels, which stackctl does
   * **not** guess (an unmapped number prints as `[UNKNOWN LOGLVL: n]`). The mapped name is then
   * matched to a canonical level like any string. Ready-made maps: `logging.nodejs.pino.levels`,
   * `logging.nodejs.winston.levels`.
   */
  levels?: Record<string, string>;
}

/**
 * What {@link createFormatter} / `logging.formatter` accepts: a {@link FormatterConfig}, or a
 * **callback** returning one for the entry being rendered. The callback receives the **parsed log**
 * — stackctl does the parsing, so there is nothing to `JSON.parse` and no non-JSON line to guard
 * against — and lets the whole config depend on the entry itself:
 *
 * ```ts
 * logging.formatter((log) => ({
 *   fields: {
 *     custom: {
 *       time: { show: false },                              // hidden on every entry
 *       ...(log.context === 'healthcheck' ? { at: { show: false } } : {}),
 *     },
 *   },
 * }))
 * ```
 *
 * It runs once per JSON-object line. Lines that aren't a JSON object never reach it; a JSON object
 * that turns out to have no level/message *does* (it picks those keys, so it has to run before that
 * check) and then passes through unformatted like any other unrecognized line.
 */
export type FormatterConfigInput =
  | FormatterConfig
  | ((log: Record<string, unknown>) => FormatterConfig);

// stackctl's canonical log levels (a complete, ordered ladder), and the aliases — matched
// case-insensitively — that fold onto them, so `WARN`/`WARNING` both become `WARN`, `ERR` becomes
// `ERROR`, syslog's `EMERGENCY`/`ALERT` and Python's `CRITICAL` become `FATAL`, etc.
const CANONICAL_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

const LEVEL_ALIASES: Record<string, string> = {
  ...Object.fromEntries(CANONICAL_LEVELS.map((l) => [l, l])), // identity: TRACE → TRACE, …
  VERBOSE: 'TRACE',
  SILLY: 'TRACE',
  FINEST: 'TRACE',
  FINE: 'DEBUG',
  FINER: 'DEBUG',
  INFORMATION: 'INFO',
  INFORMATIONAL: 'INFO',
  NOTICE: 'INFO',
  LOG: 'INFO',
  WARNING: 'WARN',
  ERR: 'ERROR',
  SEVERE: 'ERROR',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
  EMERGENCY: 'FATAL',
  EMERG: 'FATAL',
  ALERT: 'FATAL',
  PANIC: 'FATAL',
};

// Color applied to the bracketed token of a matched (known) level. Unknown levels are left
// uncolored. ANSI is kept for the on-screen view and stripped for the log file, like log prefixes.
const LEVEL_COLOR: Record<string, (s: string) => string> = {
  TRACE: chalk[LOG_LEVEL_COLORS.TRACE],
  DEBUG: chalk[LOG_LEVEL_COLORS.DEBUG],
  INFO: chalk[LOG_LEVEL_COLORS.INFO],
  WARN: chalk[LOG_LEVEL_COLORS.WARN],
  ERROR: chalk[LOG_LEVEL_COLORS.ERROR],
  // Shares ERROR's red; bold is what tells them apart.
  FATAL: chalk.bold[LOG_LEVEL_COLORS.FATAL],
};

// A property line is `  key: value`. The key is muted so it reads as a label and the value (the
// data) stands out in the normal foreground.
const PROPERTY_KEY_COLOR = chalk[LOG_PROPERTY_KEY_COLOR];

/** Leading indent of every rendered property line, beneath the `[LEVEL] message` header. */
const PROPERTY_INDENT = '  ';

/**
 * pino/bunyan's numeric levels mapped to their names (`10=TRACE … 60=FATAL`) — pino/bunyan log the
 * level as a *number*, which stackctl won't guess. Exposed as `logging.nodejs.pino.levels`.
 */
export const pinoLevels: Record<string, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/**
 * winston's npm levels mapped to stackctl's canonical levels. winston logs the level as a *string*,
 * so most match on their own — this mainly pins `http` and keeps the set explicit. Exposed as
 * `logging.nodejs.winston.levels`.
 */
export const winstonLevels: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  http: 'DEBUG',
  verbose: 'DEBUG',
  debug: 'DEBUG',
  silly: 'TRACE',
};

/** Render a JSON value for display: strings as-is, everything else via `JSON.stringify`. */
function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Indent the continuation lines of a multi-line rendered value by `width`, so they line up under
 * where the value starts instead of falling flush-left. This is also what keeps a multi-line entry
 * together: stackctl treats a line as a continuation of the previous one only when it begins with
 * whitespace, so an unindented second line would start its own log entry. Blank lines are left
 * blank rather than padded into lines of trailing spaces.
 */
function indentContinuationLines(text: string, width: number): string {
  if (!text.includes('\n')) {
    return text;
  }
  const pad = ' '.repeat(width);
  return text
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : pad + l))
    .join('\n');
}

/**
 * Resolve a raw level value to a bracketed display token, or `undefined` when there's no level.
 * A `levels` map (e.g. pino's numbers) is applied first; the resulting name — or a raw string — is
 * uppercased and matched to a canonical stackctl level, whose `[LEVEL]` token is colored by
 * severity. Anything unmatched (an unknown string, or a number with no map) becomes an uncolored
 * `[UNKNOWN LOGLVL: <value>]`; a number's meaning is never guessed.
 */
function levelToken(
  rawLevel: unknown,
  levels: Record<string, string> | undefined,
): string | undefined {
  if (rawLevel === undefined) {
    return undefined;
  }
  const key =
    typeof rawLevel === 'string' || typeof rawLevel === 'number'
      ? String(rawLevel)
      : JSON.stringify(rawLevel);
  const value = (levels ? levels[key] : undefined) ?? rawLevel;
  if (typeof value === 'string') {
    const canonical = LEVEL_ALIASES[value.toUpperCase()];
    if (canonical) {
      const paint = LEVEL_COLOR[canonical] ?? ((s: string) => s);
      return paint(`[${canonical}]`);
    }
    return `[UNKNOWN LOGLVL: ${value.toUpperCase()}]`;
  }
  return `[UNKNOWN LOGLVL: ${key}]`;
}

/**
 * Resolve one {@link FormatterConfig} into the lookups the render loop needs. The custom entries
 * become a source-field -> { display, show } map, so a property can be matched by the name it
 * actually has in the log. A static config is resolved once, when the formatter is built; a
 * callback config is resolved per line, against that line's own log.
 */
function resolveConfig(config: FormatterConfig): {
  levelKey: string;
  messageKey: string;
  levels: Record<string, string> | undefined;
  bySource: Map<string, CustomEntry>;
} {
  const bySource = new Map<string, CustomEntry>();
  for (const [display, cfg] of Object.entries(config.fields?.custom ?? {})) {
    const source = typeof cfg === 'string' ? cfg : (cfg.source ?? display);
    const show = typeof cfg === 'string' ? true : (cfg.show ?? true);
    bySource.set(source, { display, show });
  }
  return {
    levelKey: config.fields?.level ?? 'level',
    messageKey: config.fields?.message ?? 'msg',
    levels: config.levels,
    bySource,
  };
}

/**
 * **For structured (JSON) logs only.** Builds a formatter for a process that logs one JSON object
 * per line — Go `log/slog`, pino, bunyan, winston, and anything else emitting JSON — and configures
 * *how that JSON is displayed*. It cannot reshape plain-text output: every line it doesn't
 * recognize as a JSON log is returned untouched, so configuring it for a process that logs prose
 * does nothing at all. To transform arbitrary text output, write `logs.formatter` by hand — it's a
 * plain `(line: string) => string` over the raw line and has no JSON assumption.
 *
 * A recognized log renders as a `[LEVEL] message` header followed by its other properties, each
 * indented on its own line. Passed through unchanged: non-JSON lines, JSON that isn't an object,
 * and objects with no recognizable level/message under the configured keys.
 *
 * See {@link FormatterConfigInput} for the config — an object, or a callback given the parsed log.
 */
export function createFormatter(config: FormatterConfigInput = {}): (line: string) => string {
  const configFn = typeof config === 'function' ? config : null;
  const staticResolved = typeof config === 'function' ? null : resolveConfig(config);

  return (line: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // not JSON — leave it as-is
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return line; // JSON, but not a log object
    }

    const obj = parsed as Record<string, unknown>;
    // A callback config decides *which* keys hold the level and message, so it has to run before
    // the check below can be applied — it therefore sees every JSON-object line, including ones
    // that then pass through as unrecognized.
    const { levelKey, messageKey, levels, bySource } = staticResolved ?? resolveConfig(configFn!(obj)); // oxfmt-ignore

    const rawLevel = obj[levelKey];
    const message = obj[messageKey];
    if (rawLevel === undefined && message === undefined) {
      return line; // no recognizable level/message under the configured keys
    }

    const token = levelToken(rawLevel, levels);
    // A multi-line message keeps the property indent, so it reads as part of this entry.
    const renderedMessage =
      message === undefined
        ? undefined
        : indentContinuationLines(renderValue(message), PROPERTY_INDENT.length);
    const head = [token, renderedMessage].filter((v) => v !== undefined).join(' ');
    const out = [head];
    for (const [key, value] of Object.entries(obj)) {
      if (key === levelKey || key === messageKey) {
        continue;
      }
      const custom = bySource.get(key);
      if (custom && !custom.show) {
        continue;
      } // hidden
      const name = custom ? custom.display : key;
      // Continuation lines line up under the value, past the `  name: ` gutter — measured on the
      // plain name, since the printed one carries color codes.
      const gutter = PROPERTY_INDENT.length + `${name}: `.length;
      const rendered = indentContinuationLines(renderValue(value), gutter);
      out.push(`${PROPERTY_INDENT}${PROPERTY_KEY_COLOR(`${name}:`)} ${rendered}`);
    }
    return out.join('\n');
  };
}

/**
 * The formatter stackctl applies to every service's output by default (equivalent to
 * `logging.formatter()`): non-JSON lines pass through untouched, JSON logs are best-effort
 * formatted. A service's own `logs.formatter` overrides it.
 */
export const defaultFormatter = createFormatter();

/**
 * Apply an ecosystem helper's defaults to whichever config form the caller passed — folding them
 * into the callback's *result* when it's a callback, so `logging.nodejs.pino.formatter((log) => …)`
 * keeps pino's level map without the caller restating it.
 */
const withDefaults = (
  config: FormatterConfigInput,
  defaults: (config: FormatterConfig) => FormatterConfig,
): FormatterConfigInput =>
  typeof config === 'function' ? (log) => defaults(config(log)) : defaults(config);

/**
 * Helpers for displaying **structured (JSON) logs** — a process that writes one JSON object per
 * line. Every helper here builds the same formatter with different defaults for a given ecosystem,
 * and all of them share the same limitation: they configure how *recognized JSON logs* are
 * rendered, and pass every other line through untouched. None of them can reshape plain-text
 * output — for that, write `logs.formatter` yourself as a plain `(line: string) => string`.
 *
 * A plain object, not a TypeScript `namespace`: namespaces are legacy for module code and, when
 * they hold runtime values, emit non-erasable syntax that Node's `.ts` type-stripping rejects.
 */
export const logging = {
  /**
   * **For structured (JSON) logs only.** The base factory, and the exact formatter stackctl already
   * applies to every service — so you only need it to *change* something (hide a field, rename one,
   * map non-standard levels). Suits any JSON logger whose level/message keys are `level`/`msg`
   * (Go `log/slog`, pino); see {@link logging.nodejs} for ecosystem presets.
   *
   * Configuring this for a process that logs plain text does nothing — unrecognized lines pass
   * through unchanged. Use `logs.formatter` directly to transform arbitrary text output.
   */
  formatter: createFormatter,
  /** Presets for Node logging libraries — same structured-log formatter, ecosystem defaults. */
  nodejs: {
    pino: {
      /** pino/bunyan's numeric levels mapped to names (`10=TRACE … 60=FATAL`). */
      levels: pinoLevels,
      /**
       * **For structured (JSON) logs only.** {@link logging.formatter} preset for pino/bunyan: maps
       * their **numeric** levels, which stackctl won't guess on its own. Takes the same config
       * (object or callback) and keeps this default unless you override `levels`.
       */
      formatter: (config: FormatterConfigInput = {}) =>
        createFormatter(withDefaults(config, (c) => ({ ...c, levels: c.levels ?? pinoLevels }))),
    },
    winston: {
      /** winston's npm level names mapped to stackctl's canonical levels. */
      levels: winstonLevels,
      /**
       * **For structured (JSON) logs only.** {@link logging.formatter} preset for winston: reads the
       * message from `message` (not `msg`) and maps winston's level names. Takes the same config
       * (object or callback) and keeps these defaults unless you override them.
       */
      formatter: (config: FormatterConfigInput = {}) =>
        createFormatter(
          withDefaults(config, (c) => ({
            ...c,
            fields: { message: 'message', ...c.fields },
            levels: c.levels ?? winstonLevels,
          })),
        ),
    },
  },
};
