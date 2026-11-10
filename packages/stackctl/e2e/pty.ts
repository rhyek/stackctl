/**
 * The PTY harness: runs the CLI on a real pseudo-terminal through `pty_driver.py` (Node.js has no
 * PTY, and `node-pty` is a native module), keeps every byte it draws, and plays them into a
 * {@link Screen} to know what is on screen. A test types keys and clicks through it, and waits for
 * what the screen shows — never for a fixed time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { processStartTime } from '../src/process-info.js';
import { cliPath } from './cli.js';
import { childEnv, signalOwned, track, until, type Exit, type Owned } from './processes.js';
import { Screen } from './screen.js';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty_driver.py');

/** The bytes a terminal sends for the named keys; any other single character is sent as itself. */
const KEYS: Record<string, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  'ctrl-c': '\x03',
};

/** Everything that switches the terminal: the mouse's SGR reporting and the alternate screen. */
export const MOUSE_ON = '\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l';
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';

/** Matches the escape sequences a TUI paints with (SGR, cursor moves, modes, OSC strings). */
const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

type Needle = string | RegExp;
const matches = (text: string, needle: Needle) =>
  typeof needle === 'string' ? text.includes(needle) : needle.test(text);

export interface PtyOptions {
  /** The CLI's arguments. */
  args?: string[];
  cwd: string;
  /** Added to {@link childEnv}. */
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
}

export class Pty {
  /** The terminal as the bytes so far leave it, mid-frame or not: what its modes are. */
  readonly screen: Screen;
  /** The terminal as of the last complete frame: what every read of the screen sees. */
  private shown: Screen;
  /** The CLI's process (the pid the driver spawned, which is also its process group). */
  readonly owned: Owned;
  exit: Exit | null = null;
  private readonly driver: ChildProcess;
  private readonly driverOwned: Owned;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  /** Every distinct screen, in the order drawn: how a test sees a state that didn't last. */
  private readonly frames: string[] = [];
  /** The services row's dots on each frame that changed them, as {@link servicesRowDots} reads them. */
  private readonly dotFrames: string[] = [];
  private readonly untrack: () => void;

  private constructor(
    driver: ChildProcess,
    driverOwned: Owned,
    owned: Owned,
    rows: number,
    cols: number,
  ) {
    this.driver = driver;
    this.driverOwned = driverOwned;
    this.owned = owned;
    this.screen = new Screen(rows, cols);
    this.shown = this.screen.clone();
    this.screen.onFrameEnd = () => this.commit();
    this.untrack = track(this);
  }

  /** Starts the CLI on a `rows` × `cols` terminal and resolves once it runs. */
  static async start(opts: PtyOptions): Promise<Pty> {
    const rows = opts.rows ?? 50;
    const cols = opts.cols ?? 200;
    const driver = spawn(
      'python3',
      [
        '-B',
        '-u',
        DRIVER,
        String(rows),
        String(cols),
        '--',
        process.execPath,
        cliPath,
        ...(opts.args ?? []),
      ],
      { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'inherit', 'pipe'] },
    );
    const driverOwned: Owned = { pid: driver.pid!, startedAt: await processStartTime(driver.pid!) };
    const events = readline.createInterface({ input: driver.stdio[3] as NodeJS.ReadableStream });
    const output: Buffer[] = [];
    const early = (chunk: Buffer) => output.push(chunk);
    driver.stdout!.on('data', early);

    // An EPIPE once the driver is gone is no error of the test's.
    driver.stdin!.on('error', () => {});

    const pty = await new Promise<Pty>((resolve, reject) => {
      let created: Pty | undefined;
      let exit: Exit | undefined;
      let ended = false;
      // The exit is known once the driver has reported it and every byte before it has arrived.
      const settle = () => {
        if (created && exit && ended) {
          created.exit = exit;
        }
      };
      driver.stdout!.once('end', () => {
        ended = true;
        settle();
      });
      events.on('line', (line) => {
        const event = JSON.parse(line) as
          | { event: 'spawned'; pid: number }
          | { event: 'exit'; code: number | null; signal: string | null };
        if (event.event === 'spawned') {
          void processStartTime(event.pid).then((startedAt) => {
            const made = new Pty(driver, driverOwned, { pid: event.pid, startedAt }, rows, cols);
            driver.stdout!.off('data', early);
            output.forEach((chunk) => made.feed(chunk));
            driver.stdout!.on('data', (chunk: Buffer) => made.feed(chunk));
            created = made;
            settle();
            resolve(made);
          });
        } else {
          exit = { code: event.code, signal: event.signal };
          settle();
        }
      });
      driver.once('exit', (code) => {
        if (!created) {
          reject(new Error(`pty_driver.py exited (${String(code)}) before the CLI started`));
        }
      });
    });
    return pty;
  }

  private feed(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    // Ink draws each frame as one synchronized update (`ESC[?2026h` … `ESC[?2026l`). A screen read
    // halfway through one would show a state the program never drew, so a read sees the screen as
    // the last update ended (the screen calls back), or as a chunk ends outside of one.
    this.screen.feed(chunk);
    if (this.screen.modes.get(2026) !== true) {
      this.commit();
    }
  }

  private commit(): void {
    this.shown = this.screen.clone();
    const frame = this.shown.dump();
    if (this.frames.at(-1) !== frame) {
      this.frames.push(frame);
    }
    const dots = this.servicesRowDots();
    if (this.dotFrames.at(-1) !== dots) {
      this.dotFrames.push(dots);
    }
  }

  /** What is on the screen now, trailing blanks trimmed. */
  text(): string {
    return this.shown.dump();
  }

  /** Each row on the screen now, trailing blanks trimmed. */
  lines(): string[] {
    return this.shown.lines();
  }

  /** The last `n` non-blank rows on screen: the footer, on the run screen. */
  footer(n = 3): string {
    return this.lines()
      .filter((line) => line.trim() !== '')
      .slice(-n)
      .join('\n');
  }

  /**
   * The run screen's application services, as `name:color` for each dot on the row under the rule
   * line (`api:32 web:33`), the color being the SGR code the dot was drawn in.
   */
  servicesRowDots(): string {
    const lines = this.shown.lines();
    const at = lines.findLastIndex((line) => line.startsWith('── ')) + 1;
    const line = lines[at] ?? '';
    const colors = this.shown.colorsAt(at);
    const dots: string[] = [];
    for (const m of line.matchAll(/([●○]) (\S+)/g)) {
      dots.push(`${m[2]!}:${colors[m.index] ?? ''}`);
    }
    return dots.join(' ');
  }

  /**
   * The service focused on the run screen: the one whose name the footer draws in white (the
   * others are in the terminal's default color), or `null` when none is.
   */
  focusedService(): string | null {
    const lines = this.shown.lines();
    const rule = lines.findLastIndex((line) => line.startsWith('── '));
    if (rule === -1) {
      return null;
    }
    for (let at = rule + 1; at < lines.length; at++) {
      const colors = this.shown.colorsAt(at);
      for (const m of (lines[at] ?? '').matchAll(/[●○] (\S+)/g)) {
        if (colors[m.index + 2] === '37') {
          return m[1]!;
        }
      }
    }
    return null;
  }

  /** Whether the services row's dots, as {@link servicesRowDots} reads them, ever matched `needle`. */
  everDots(needle: Needle): boolean {
    return this.dotFrames.some((dots) => matches(dots, needle));
  }

  /** Every byte drawn so far, or since `mark` (a value of {@link mark}). */
  raw(mark = 0): string {
    return Buffer.concat(this.chunks).subarray(mark).toString('utf8');
  }

  /** Where the output stands now, for {@link raw}. */
  mark(): number {
    return this.bytes;
  }

  /** Whether any screen drawn so far matched `needle`. */
  everShown(needle: Needle): boolean {
    return this.frames.some((frame) => matches(frame, needle));
  }

  /** The screens drawn so far that matched `needle`, in order. */
  framesWith(needle: Needle): string[] {
    return this.frames.filter((frame) => matches(frame, needle));
  }

  /** Waits until the screen shows `needle`; rejects with the screen after `timeout` or an exit. */
  async waitFor(needle: Needle, timeout = 30_000): Promise<void> {
    await this.waitUntil(
      () => matches(this.text(), needle),
      `${String(needle)} on screen`,
      timeout,
    );
  }

  /** Waits until `predicate` holds; rejects with the screen after `timeout` or if the CLI exits. */
  async waitUntil(predicate: () => boolean, what: string, timeout = 30_000): Promise<void> {
    await until(
      () => {
        if (predicate()) {
          return true;
        }
        if (this.exit) {
          throw new Error(
            `the CLI exited (${JSON.stringify(this.exit)}) waiting for ${what}:\n${this.text()}`,
          );
        }
        return false;
      },
      timeout,
      () => `waiting for ${what}; the screen:\n${this.text()}`,
    );
  }

  /** Waits for the CLI to exit and resolves with how; rejects after `timeout`. */
  async waitForExit(timeout = 30_000): Promise<Exit> {
    await until(
      () => this.exit !== null,
      timeout,
      () => `the CLI never exited; the screen:\n${this.text()}`,
    );
    return this.exit!;
  }

  private send(request: Record<string, unknown>): void {
    this.driver.stdin!.write(`${JSON.stringify(request)}\n`);
  }

  /** Types `text` as it is. */
  type(text: string): void {
    this.send({ op: 'write', data: Buffer.from(text).toString('base64') });
  }

  /** Presses each key: a name from {@link KEYS} or a single character. */
  press(...keys: string[]): void {
    for (const key of keys) {
      const bytes = KEYS[key] ?? (key.length === 1 ? key : undefined);
      if (bytes === undefined) {
        throw new Error(`unknown key ${key}`);
      }
      this.type(bytes);
    }
  }

  /** A left click (press and release, SGR encoding) at the 1-based `col`, `row`. */
  click(col: number, row: number): void {
    this.type(`\x1b[<0;${String(col)};${String(row)}M\x1b[<0;${String(col)};${String(row)}m`);
  }

  /** Clicks `offset` cells into where `text` last appears on screen; throws when it isn't there. */
  clickText(text: string, offset = 0): void {
    const at = this.shown.find(text);
    if (!at) {
      throw new Error(`${JSON.stringify(text)} isn't on screen:\n${this.text()}`);
    }
    this.click(at.col + offset, at.row);
  }

  /** Sends `signal` to the CLI itself. */
  signal(signal: NodeJS.Signals): void {
    this.send({ op: 'signal', name: signal });
  }

  /**
   * Ends the CLI if the test didn't: SIGTERM (its own graceful shutdown, which stops its services),
   * then SIGKILL to its process group; then the driver.
   */
  async close(): Promise<void> {
    if (!this.exit) {
      this.signal('SIGTERM');
      await this.waitForExit(15_000).catch(() => signalOwned(this.owned, 'SIGKILL', true));
    }
    await until(
      () => this.driver.exitCode !== null || this.driver.signalCode !== null,
      5_000,
      () => 'pty_driver.py never exited',
    ).catch(() => signalOwned(this.driverOwned, 'SIGKILL'));
    this.untrack();
  }
}
