/**
 * A duration in words for the exit line: `3 days 2 hours 3 minutes`. Units that are zero
 * are left out, and seconds appear only while the whole duration is under a minute. Rounds
 * down, so a unit never reads as the next one up.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return plural(totalSeconds, 'second');
  }
  const units: [number, string][] = [
    [Math.floor(totalSeconds / 86_400), 'day'],
    [Math.floor((totalSeconds % 86_400) / 3600), 'hour'],
    [Math.floor((totalSeconds % 3600) / 60), 'minute'],
  ];
  return units
    .filter(([count]) => count > 0)
    .map(([count, unit]) => plural(count, unit))
    .join(' ');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** An SGR (color and style) escape sequence: ESC `[`, digits and `;`, then `m`. */
const SGR_SEQUENCE = new RegExp(String.raw`\u001b\[[\d;]*m`, 'g');

/** Strips ANSI SGR (color) escape sequences, so logfiles hold plain text. */
export function stripAnsi(text: string): string {
  return text.replaceAll(SGR_SEQUENCE, '');
}

/** The last stamp made, and the second it was made in. */
let lastStamp: { second: number; text: string } | undefined;

/** `n` as two digits, a leading zero below ten. */
function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * `YYYY-MM-DD HH:MM:SS` local-time (24-hour) stamp prefixed to each logged line. Lines logged in
 * the same second get the same string, so the lines a session keeps share their stamps.
 */
export function logTimestamp(): string {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  if (lastStamp?.second === second) {
    return lastStamp.text;
  }
  const d = new Date(now);
  const date = [String(d.getFullYear()), twoDigits(d.getMonth() + 1), twoDigits(d.getDate())];
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map(twoDigits);
  const text = [date.join('-'), time.join(':')].join(' ');
  lastStamp = { second, text };
  return text;
}

/**
 * The command line `/bin/sh -c` would run for `command` and `args`: a script's own text as it is
 * (`/bin/sh -c <text>`), anything else as its words, each quoted where the shell needs it.
 */
export function commandLine(command: string, args: readonly string[]): string {
  if (command === '/bin/sh' && args.length === 2 && args[0] === '-c') {
    return args[1]!;
  }
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
