import type { AnyServiceConfig, ResolvedHealthcheck, UrlEntry, UrlLine } from '../config.js';
import type { EnvFileOrder, EnvOverride } from '../env-base.js';
import type { InfraWatch } from '../infra/provider.js';
import type { InfraServiceState } from '../infra/types.js';

// The types a dev session's runtime shares: what a selection runs, what its infra step hands
// over, and the log records every part of it writes and reads.

/** What a selection runs: the services, how they wait on each other, and the session's settings. */
export interface SessionPlan {
  /**
   * Every service the session runs, in display order: the most depended-on first, then the ones
   * picked over the ones only pulled in, then by name. A service added mid-session is appended.
   */
  sortedPackages: AnyServiceConfig[];
  /** The names the user picked, without the deps they pull in. */
  picked: Set<string>;
  /** Service name → the services it is held until ready. Only services that wait have an entry. */
  waitsOn: Record<string, string[]>;
  /** Service name → its healthcheck. Only services that declare one have an entry. */
  healthchecks: Record<string, ResolvedHealthcheck>;
  /** Service name → the scripts or make targets the commands menu lists. Only non-empty entries. */
  menuCommands: Record<string, string[]>;
  /** The workspace-wide `urls`, normalized; absent when the config declares none. */
  topLevelUrls?: UrlLine[];
  /** The `.env` files looked for at each scope; absent means the mode's own. */
  envFiles?: EnvFileOrder;
  /** Variables whose `.env` or `env.vars` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** Whether dotenvx's encrypted values are decrypted (`env.decrypt`); absent means not. */
  envDecrypt?: boolean;
  /** The config's own variables (`env.vars`), ranked as a file below the `.env` files. */
  envVars?: Record<string, string>;
  /** Whether lines show their timestamp on screen when their service doesn't say; absent means on. */
  logTimestamps?: boolean;
  /** The workspace root every service's `relativeDir` resolves against; absent means `process.cwd()`. */
  cwd?: string;
  /** The session's infra once it is up; absent when the config declares none. */
  infra?: SessionInfra;
}

/** What a session's infra step hands the run phase. */
export interface SessionInfra {
  /** One entry per infra service brought up, in the order the provider reported them. */
  services: { provider: string; name: string; urls?: UrlEntry[] }[];
  /** Starts a live watch of the services' states, calling back with every change. */
  watch?: (onStates: (states: Map<string, InfraServiceState>) => void) => InfraWatch;
  /** Memory per running infra service, in bytes. */
  readMemory?: () => Promise<Map<string, number>>;
}

/** One line infra printed while the session started. */
export interface InfraLogLine {
  /** The infra service it belongs to; absent for the provider's own output. */
  service?: string;
  /** As printed, without a newline. */
  text: string;
  /** It came from stderr. */
  isError: boolean;
}

/**
 * How much of a line's timestamp the log shows: the full `YYYY-MM-DD HH:MM:SS` stamp, just
 * `HH:MM:SS`, or no timestamp column at all.
 */
export type TimestampMode = 'date' | 'time' | 'none';

/** A log line's gutter label: the name between its brackets, and the color it is drawn in. */
export interface LogLabel {
  name: string;
  /** Colors the whole bracketed label; absent, it is drawn uncolored. */
  paint?: (text: string) => string;
}

/** One buffered log record. */
export interface LogLine {
  /** Increases in append order. */
  id: number;
  /** The service the line is filed under; `null` for stackctl's own lines and infra's. */
  service: string | null;
  /** The text as drawn: colors kept, tabs expanded. */
  text: string;
  /** It came from stderr, or is an error-level record. */
  isError: boolean;
  /** When it was appended, epoch ms. */
  at: number;
  /**
   * The stamp, `YYYY-MM-DD HH:MM:SS` in local time (`format.ts` `logTimestamp()`), made when the line
   * was appended. Lines appended in the same second share one string.
   */
  ts: string;
  /** Whether the line shows its timestamp on screen. The logfile always has it. */
  showTs: boolean;
  /**
   * The gutter label the line is drawn with, `[name]`. It is padded when it is drawn, to the
   * width the log holds then ({@link labelGutter}), so it lines up with every other line's.
   */
  label: LogLabel;
  /** The word the filter matches besides the text: a service's name lowercased, `system`, … */
  filterKey: string;
  /**
   * Whether the line continues the previous entry of its filter key, so the filter shows or hides
   * them together. The appender sets it when it knows the structure (`false` on the first line of
   * a formatter's multi-line result, `true` on the rest); left out, the line continues an entry
   * when its text, past any leading colors, starts with a space or a tab.
   */
  continues?: boolean;
}

/** One screen row of a {@link LogLine}. */
export interface WrappedRow {
  /** The row as drawn, gutter included, colors intact. */
  text: string;
  /** The column where the row's own content begins: past the gutter and any hanging indent. */
  contentStart: number;
  /** The columns of the gutter's `[label]`, brackets included, end exclusive. */
  label: { start: number; end: number };
}

/**
 * What the log shows. A line matches when every whitespace-separated term of `text` is found in
 * its filter key and text, ignoring case and accents, and, with `service`, when it is filed under
 * that service. An entry is shown whole when any of its lines matches.
 */
export interface LogFilter {
  text: string;
  service?: string;
}
