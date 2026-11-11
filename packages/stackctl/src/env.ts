import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import primitives from '@dotenvx/primitives';
import type { AnyServiceConfig } from './config.js';
import {
  INJECTED_ENV_VAR,
  REPLACED_ENV_VAR,
  RESOLVE_ENV_FD,
  assertOutsideCli,
  assertValidMode,
  currentMode,
  envFileNames,
  rejectUnknownOptions,
  shellEnvironment,
  type EnvFileOrder,
  type EnvOverride,
  type Mode,
} from './env-base.js';
import { type EnvFilesReading, readEnvFiles, readEnvFilesSync } from './env-file-reader.js';
import { resolverArgs } from './one-off/resolver-args.js';
import type { ResolvedTarget } from './target.js';

// Reading and resolving the `.env` files. What needs no file is in `env-base.ts`, re-exported here
// so this module is the one to import for either. A command that resolves no environment imports
// `env-base.ts` alone, and never loads the parser.
export * from './env-base.js';

export interface EnvResolution {
  /**
   * Variables defined by the resolved files, already `${VAR}`-expanded and with the ambient
   * environment's precedence already applied. Does NOT include the rest of `process.env` — merge
   * yourself with `Object.assign({}, process.env, env)`.
   */
  env: Record<string, string>;
  /** Candidate paths that exist and were loaded, ascending precedence. */
  files: string[];
  /** Every candidate path (whether or not it exists), ascending precedence. */
  candidates: string[];
  /**
   * The names the service's own files assign, as against the workspace's. When `relativeDir`
   * is the workspace root the one scope is the service's, so this is every file's names.
   */
  packageNames: Set<string>;
}

interface ResolveEnvOptions {
  /** Workspace root. */
  cwd: string;
  /**
   * Service directory relative to `cwd`. Defaults to `'.'`, which collapses service scope onto
   * the workspace, so only the workspace's files are read.
   */
  relativeDir?: string;
  /**
   * The mode whose {@link envFileNames} to look for at each scope. Defaults to the active mode
   * ({@link currentMode}). Ignored when `files` is given.
   */
  mode?: Mode;
  /**
   * Filenames to look for, ascending precedence: one list for both scopes, or one per scope (a
   * config's `envFiles`). Takes precedence over `mode`.
   */
  files?: string[] | EnvFileOrder;
  /** Variables the files may override the ambient environment for. */
  override?: EnvOverride;
  /**
   * The config's own variables (`env.vars`, resolved). They rank as a file read before every
   * real one, under the same rules: any file replaces them, the ambient environment wins over
   * them unless `override` says otherwise, and a file's `${VAR}` can reference them.
   */
  vars?: Record<string, string>;
  /**
   * The ambient environment to resolve against. Defaults to the one stackctl was started with
   * (see {@link captureShellEnv}), or the live `process.env` when none was recorded.
   */
  ambient?: Record<string, string>;
}

/** An {@link EnvResolution} as JSON carries it, its set as an array: see `RESOLVE_ONE_OFF_COMMAND`. */
export interface SerializedEnvResolution extends Omit<EnvResolution, 'packageNames'> {
  packageNames: string[];
}

/** An `.env` file's text, or null when there is no such file. */
export type EnvFileReader = (file: string) => string | null;

function readEnvFileSync(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** How long loading a config waits on its `.env` files when one is a link; see {@link configEnvReader}. */
export const CONFIG_ENV_READ_TIMEOUT_MS = 10_000;

/**
 * The reader a config's callbacks get their `.env` files through, made once for every file they may
 * read. Loading a config is synchronous, so it can only wait on a read, but a read can block for as
 * long as something else decides: macOS holds a read of a File Provider folder (Dropbox, iCloud)
 * until the user answers its prompt to allow access. A file is kept in such a folder by linking to
 * it, so when any of `files` is a link they are all read at once in a child process, waited on for
 * at most `timeoutMs`: a read that doesn't return by then fails the load, naming the file, rather
 * than holding it. Otherwise each is read here, as it is needed.
 */
export function configEnvReader(
  files: string[],
  timeoutMs: number = CONFIG_ENV_READ_TIMEOUT_MS,
): EnvFileReader {
  const linked = files.some((file) => {
    try {
      // The link's own entry, in the workspace: it is the file it points to that may block.
      return fs.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!linked) {
    return readEnvFileSync;
  }
  const results = readEnvFilesSync(files, timeoutMs);
  return (file) => {
    const result = results.get(file);
    if (result === undefined) {
      return readEnvFileSync(file);
    }
    if (result.kind === 'error') {
      throw Object.assign(new Error(`${result.code}: couldn't read ${file}`), {
        code: result.code,
      });
    }
    return result.kind === 'text' ? result.text : null;
  };
}

/**
 * The `.env` files' contents as last read, so a session resolves a service's environment without
 * touching the disk. A read can block for as long as something else decides: macOS holds a read
 * of a File Provider folder (Dropbox, iCloud) until the user answers its prompt to allow access,
 * which can be hours. So a session never reads its files on the event loop's thread, where a read
 * that doesn't return would stop it answering its control API, reading its services' output, and
 * acting on a signal to stop: every read is {@link refresh}'s, in a child process
 * ({@link readEnvFiles}). Only loading the config reads synchronously, and it is done before
 * anything handles a signal, so a signal still ends the process.
 */
export class EnvFileSnapshot {
  private readonly texts = new Map<string, string | null>();
  /** Files {@link refresh} was asked to add, for the next pass to read. */
  private readonly adding = new Set<string>();
  private inFlight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private current: EnvFilesReading | null = null;
  private waitingOn: string | null = null;
  private disposed = false;

  /** A file's text as last read; null when it doesn't exist, or hasn't been read yet. */
  readonly read: EnvFileReader = (file) => this.texts.get(file) ?? null;

  /** The file the read under way is waiting on, or null when none is under way. */
  get reading(): string | null {
    return this.waitingOn;
  }

  /**
   * Reads every file again, and `files` for the first time, settling once a pass begun after this
   * call is done. One pass at a time, with every call made during a pass sharing the next: a read
   * that doesn't return holds one reader, not one per call.
   */
  refresh(files: Iterable<string> = []): Promise<void> {
    for (const file of files) {
      if (!this.texts.has(file)) {
        this.adding.add(file);
      }
    }
    if (!this.inFlight) {
      this.inFlight = this.pass().finally(() => {
        this.inFlight = null;
      });
      return this.inFlight;
    }
    this.queued ??= this.inFlight.then(() => {
      this.queued = null;
      return this.refresh();
    });
    return this.queued;
  }

  /** Stops a read under way, and every one after: what was read stays as it was. */
  dispose(): void {
    this.disposed = true;
    this.current?.cancel();
  }

  private async pass(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const files = [...this.texts.keys(), ...this.adding];
    this.adding.clear();
    this.current = readEnvFiles(files, (file) => {
      this.waitingOn = file;
    });
    const results = await this.current.done;
    this.current = null;
    this.waitingOn = null;
    for (const [file, result] of results) {
      if (result.kind === 'text') {
        this.texts.set(file, result.text);
      } else if (result.kind === 'missing' || !this.texts.has(file)) {
        this.texts.set(file, null);
      }
      // A file that read before and fails now keeps what it last read as.
    }
  }
}

/**
 * Every candidate `.env` path, ascending precedence: all workspace-scope files (in
 * `files` order), then all service-scope files (in `files` order). Service scope always
 * outranks workspace scope. When `relativeDir` resolves to `cwd`, the two scopes collapse
 * into one, which reads the workspace's files.
 */
export function envCandidatePaths({
  cwd,
  relativeDir = '.',
  mode,
  files,
}: Pick<ResolveEnvOptions, 'cwd' | 'relativeDir' | 'mode' | 'files'>): string[] {
  const order = files ?? envFileNames(mode === undefined ? currentMode() : assertValidMode(mode));
  const workspaceNames = Array.isArray(order) ? order : order.workspace;
  const serviceNames = Array.isArray(order) ? order : order.service;
  const workspaceDir = path.resolve(cwd);
  const pkgDir = path.resolve(cwd, relativeDir);
  const inWorkspace = workspaceNames.map((f) => path.join(workspaceDir, f));
  return pkgDir === workspaceDir
    ? inWorkspace
    : [...inWorkspace, ...serviceNames.map((f) => path.join(pkgDir, f))];
}

/**
 * `layer` with {@link INJECTED_ENV_VAR} added: every variable of the child's environment — this
 * process's own, with `layer` merged over it — that the shell stackctl was started in didn't
 * set, or set to another value. Those it had set to another value go in
 * {@link REPLACED_ENV_VAR} with the shell's value, itself listed.
 */
function withInjectedList(layer: Record<string, string>): Record<string, string> {
  const shell = shellEnvironment();
  const child: NodeJS.ProcessEnv = { ...process.env, ...layer };
  const injected = Object.keys(child).filter(
    (key) =>
      key !== INJECTED_ENV_VAR &&
      key !== REPLACED_ENV_VAR &&
      key !== 'STACKCTL_MODE' &&
      child[key] !== undefined &&
      child[key] !== shell[key],
  );
  const replaced = Object.fromEntries(
    injected.flatMap((key) => (shell[key] === undefined ? [] : [[key, shell[key]]])),
  );
  if (Object.keys(replaced).length === 0) {
    return { ...layer, [INJECTED_ENV_VAR]: injected.sort().join(',') };
  }
  return {
    ...layer,
    [REPLACED_ENV_VAR]: JSON.stringify(replaced),
    [INJECTED_ENV_VAR]: [...injected, REPLACED_ENV_VAR].sort().join(','),
  };
}

/**
 * A token to stand in for `$`, found in none of `texts` — so swapping it back afterwards can
 * only ever bring back a `$` that {@link hideDollars} hid.
 */
function dollarStandIn(texts: string[]): string {
  for (let n = 0; ; n++) {
    // Private-use delimiters around a counter: no occurrence can straddle two of them.
    const standIn = `\uE000${String(n)}\uE001`;
    if (!texts.some((text) => text.includes(standIn))) {
      return standIn;
    }
  }
}

/**
 * Hides every `$` in values that are *already final* — the ambient environment's, the config's
 * own variables — behind `standIn`, for use as dotenvx's `processEnv`.
 *
 * Such a value is data, not a template, but dotenvx scans whatever it substitutes for further
 * references, and it keeps doing so as later lines build on the result. That causes failures
 * this prevents structurally (dotenvx never sees a `$` it didn't read from a file, at any depth
 * of reference, so there is nothing to scan):
 *
 * - **A hang.** An ambient `NODE_OPTIONS` that itself contains a literal `${NODE_OPTIONS}`, plus a
 *   file line `NODE_OPTIONS="${NODE_OPTIONS} --flag"`, is a cycle: substitute, re-scan, find the
 *   reference again, forever — with no error and no output.
 * - **Silent mangling.** Ambient `GREETING=hello$world` with a file line `MSG="${GREETING}!"`
 *   resolved to `hello`, because `$world` was treated as a reference and expanded to nothing.
 * - **A command run.** A `$(command)` in such a value is text, not a substitution to perform.
 *
 * {@link ambientEnv} keeps returning real values — hidden ones must never reach the `envs` a
 * config callback sees; {@link resolveEnvFrom} swaps the `$` back into everything it returns.
 *
 * Exported for tests only (not re-exported from `index.ts`). The invariant it guarantees — no
 * `$` survives — is what the regression test asserts directly, because the failure it prevents
 * is a *synchronous* infinite loop: a test that merely calls `resolveEnvFrom` would hang the runner
 * rather than fail, since no timeout can interrupt a blocked event loop.
 */
export function hideDollars(
  values: Record<string, string>,
  standIn: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replaceAll('$', standIn);
  }
  return out;
}

/** A name a `.env` line can carry: what dotenv's line grammar accepts on the left of `=`. */
export const ENV_NAME_RE = /^[\w.-]+$/;

/**
 * dotenv's line grammar, as dotenvx reads it. A quoted value may span lines, and a line inside
 * one assigns nothing — which is why this is the grammar and not a search for `NAME=`.
 */
const ENV_LINE_RE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * The names a `.env` source assigns, without resolving any value — dotenvx offers no parse
 * that doesn't also expand references and run `$(command)` substitutions.
 */
export function assignedNames(source: string): Set<string> {
  const lines = source.replace(/\r\n?/g, '\n').matchAll(ENV_LINE_RE);
  return new Set(Array.from(lines, (line) => line[1] ?? ''));
}

/**
 * Variables as the source of a `.env` file, so they resolve by the very rules a file's do: a
 * later line replaces them, and a later line's `${VAR}` references them.
 *
 * Each line assigns the variable from a placeholder that holds its value — `placeholders`, for
 * the environment the source is expanded against — so nothing in the value has to survive
 * dotenv's own syntax: quotes, newlines, a `#`.
 */
function asEnvSource(
  vars: Record<string, string>,
  placeholderPrefix: string,
): { source: string; placeholders: Record<string, string> } {
  const placeholders: Record<string, string> = {};
  const lines = Object.entries(vars).map(([name, value], i) => {
    const placeholder = `${placeholderPrefix}${String(i)}`;
    placeholders[placeholder] = value;
    return `${name}=\${${placeholder}}`;
  });
  return { source: lines.join('\n'), placeholders };
}

/** The options {@link resolveEnv} takes, checked at runtime since a JavaScript caller bypasses the types. */
const RESOLVE_ENV_OPTIONS = ['mode', 'target', 'workspaceDir'];

/**
 * The environment stackctl starts a target's command with, as `exec()` runs it: the config's
 * `env.vars`, the `.env` files of the mode, `env.additionalFiles` and `env.override` applied, and
 * for a service its `PORT`, `PUBLIC_ORIGIN` and `NODE_EXTRA_CA_CERTS`, with `STACKCTL_MODE`,
 * `STACKCTL_CWD` and `STACKCTL_WORKSPACE_DIR`.
 *
 * Synchronous: stackctl's CLI runs in a child process, loads the config in the mode asked for and
 * writes what it resolved (see `RESOLVE_ONE_OFF_COMMAND`). A child, not the config imported
 * here: importing it would resolve it in this process's mode, once, into this process's module
 * state, where the CLI resolves it in the mode asked for and leaves the caller's alone.
 *
 * Throws what stackctl said when it can't resolve: no config, an unknown target. Throws inside
 * stackctl's own process — from the config, or a callback it runs — where it would load the
 * config again.
 */
export function resolveEnv(
  opts: {
    /**
     * The mode, selecting the `.env.<mode>` files to load. Default: this process's `STACKCTL_MODE`
     * when set (a process a stackctl started keeps its mode), else `'test'` in CI, else
     * `'development'`.
     */
    mode?: string;
    /**
     * The target: a service's name or a path, relative to the current directory (or to
     * `workspaceDir` when given). A path inside a service is that service. Omitted, the current
     * directory, or the workspace root with `workspaceDir`.
     */
    target?: string;
    /**
     * The workspace root, the directory holding `stackctl.config.ts`, exactly: no walk-up. Default:
     * the nearest directory at or above the current one with a config.
     */
    workspaceDir?: string;
  } = {},
): EnvResolution {
  assertOutsideCli('resolveEnv');
  rejectUnknownOptions('resolveEnv', opts, RESOLVE_ENV_OPTIONS);
  // Asked for no command: the environment only.
  const args = resolverArgs(opts);
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    // What the config prints goes to this process's stderr, never into its stdout.
    stdio: ['ignore', 2, 'pipe', 'pipe'],
    encoding: 'utf8',
    // An environment, and what the config printed: far past the 1 MB default never fails a call.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) {
    throw child.error;
  }
  const stderr = child.stderr ?? '';
  const out = (child.output[RESOLVE_ENV_FD] as string | null | undefined) ?? '';
  if (child.status !== 0 || !out) {
    const why =
      stderr.trim() || `stackctl exited with ${child.signal ?? `code ${String(child.status)}`}`;
    throw new Error(why);
  }
  // What the config or dotenvx said along the way, as a session would have printed it.
  process.stderr.write(stderr);
  // The resolver writes more — the command it wasn't asked for, the log directory — than this returns.
  const { env, files, candidates, packageNames } = JSON.parse(out) as SerializedEnvResolution;
  return { env, files, candidates, packageNames: new Set(packageNames) };
}

/**
 * dotenvx's file of decryption keys, which it looks for in the working directory. A reader that
 * {@link resolveEnvFrom} is given reads it too, so it must have it: see {@link EnvFileSnapshot}.
 */
export function envKeysFile(): string {
  return path.resolve('.env.keys');
}

/**
 * The private keys in a `.env.keys` file's text, as dotenvx takes them from the environment:
 * each under a name of its own, a list of keys split apart, as dotenvx splits one in the file.
 */
function privateKeys(text: string | null): Record<string, string> {
  const keys: Record<string, string> = {};
  if (text === null) {
    return keys;
  }
  let i = 0;
  for (const [name, values] of Object.entries(primitives.scan(text).parsed)) {
    if (!name.startsWith('DOTENV_PRIVATE_KEY')) {
      continue;
    }
    for (const key of values.flatMap((value) => value.split(','))) {
      keys[`DOTENV_PRIVATE_KEY__STACKCTL_KEYS_FILE_${String(i++)}`] = key;
    }
  }
  return keys;
}

/**
 * Resolves the `.env` files for a service into a flat, expanded variable map without touching
 * `process.env`. Only files that exist are loaded; a later file (or a service-scope file)
 * overrides an earlier one, and every file overrides the config's own `vars`.
 *
 * The **ambient environment wins** over the files — matching Next.js, Vite, dotenv-flow and
 * `node --env-file`, so `FOO=bar stackctl` overrides a file for one run. `override` names the
 * exceptions: variables whose file value is allowed to win instead (or `true` for all of them).
 * Ambient means what stackctl was started with: a variable only the files define is never
 * ambient, so its highest-ranked file wins whatever `override` says.
 *
 * A `${VAR}` reference expands to the value that wins: the ambient one, or for an overridden
 * variable whatever the lines read so far have made of it — which starts as the ambient value,
 * so `NODE_OPTIONS=$NODE_OPTIONS --flag` extends it.
 *
 * Each candidate file is read by `read`, and {@link envKeysFile} too. With no `read`, the files
 * are read from disk, synchronously, and dotenvx reads its keys itself.
 */
export function resolveEnvFrom(opts: ResolveEnvOptions, given?: EnvFileReader): EnvResolution {
  const read = given ?? readEnvFileSync;
  const candidates = envCandidatePaths(opts);
  const files: string[] = [];
  const texts: string[] = [];
  for (const file of candidates) {
    const text = read(file);
    if (text !== null) {
      files.push(file);
      texts.push(text);
    }
  }

  const ambient = opts.ambient ?? shellEnvironment();
  const vars = opts.vars ?? {};
  const pkgDir = path.resolve(opts.cwd, opts.relativeDir ?? '.');
  const packageNames = assignedNames(
    texts.filter((_text, i) => path.dirname(files[i] ?? '') === pkgDir).join('\n'),
  );
  if (Object.keys(vars).length === 0 && !texts.join('').trim()) {
    return { env: {}, files, candidates, packageNames };
  }

  // An ambient variable the files may override stops being ambient for this resolution: it
  // becomes the first line read, ahead of the config's own variables and every file. So the
  // lines that assign it win, each one's reference to it sees what the lines before left —
  // the ambient value, for the first — and every later reference sees the result. The rest of
  // the ambient environment wins as ever, for the variable itself and for references to it.
  const { override } = opts;
  const assigned = new Set([...Object.keys(vars), ...assignedNames(texts.join('\n'))]);
  const isOverridden = (key: string) =>
    assigned.has(key) && (override === true || (Array.isArray(override) && override.includes(key)));
  const winning: Record<string, string> = {};
  const overridable: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    (isOverridden(key) ? overridable : winning)[key] = value;
  }

  const fromAmbient = asEnvSource(overridable, '__STACKCTL_AMBIENT_');
  const fromVars = asEnvSource(vars, '__STACKCTL_VAR_');
  const final = { ...winning, ...fromAmbient.placeholders, ...fromVars.placeholders };
  const standIn = dollarStandIn([...Object.values(final), ...texts]);
  // dotenvx's parser, taken from the service it lives in: `@dotenvx/dotenvx` wraps the same
  // call in a CLI's worth of tooling, which costs every command its load time. It reads from
  // `processEnv` for `$VAR` lookups but writes to neither it nor the real process.env, so
  // nothing is mutated.
  // The keys are only ever looked up by dotenvx, never by a `${VAR}`: each under a name of its own,
  // they can't shadow a variable.
  const { parsed, errors } = primitives.parseSync(
    [fromAmbient.source, fromVars.source, ...texts].join('\n'),
    given
      ? {
          processEnv: { ...hideDollars(final, standIn), ...privateKeys(given(envKeysFile())) },
          overload: false,
          fk: [],
        }
      : { processEnv: hideDollars(final, standIn), overload: false },
  );
  // An encrypted value with no key to decrypt it stays as it is; say which, as dotenvx does.
  for (const error of errors) {
    console.error(error.message);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    env[key] = value.replaceAll(standIn, '$');
  }
  return { env, files, candidates, packageNames };
}

/** What an environment layer is built from; see {@link packageEnvLayer}. */
interface EnvLayerOptions {
  /** Workspace root. */
  cwd: string;
  /**
   * Filenames to look for, one list for both scopes or one per scope (defaults to the active
   * mode's {@link envFileNames}).
   */
  files?: string[] | EnvFileOrder;
  /** Variables the files may override the ambient environment for. */
  override?: EnvOverride;
  /** The config's own variables (`env.vars`, resolved); see {@link ResolveEnvOptions.vars}. */
  vars?: Record<string, string>;
  /**
   * The trust file of the dev reverse proxy's self-signed certificates, injected as
   * `NODE_EXTRA_CA_CERTS`, so a Node process trusts the proxy's `https://` origins.
   */
  extraCaCerts?: string;
  /**
   * Reads a candidate file, and dotenvx's {@link envKeysFile}; from disk, synchronously, unless
   * given.
   */
  read?: EnvFileReader;
}

/**
 * The environment layer for a service's child process: the config's own variables and its
 * `.env` files, resolved together, with the service's configured `port` as `PORT`, its public
 * origin as `PUBLIC_ORIGIN`, and the trust file of the proxy's self-signed certificates (if any)
 * as `NODE_EXTRA_CA_CERTS`. Those are the service's own, so they win over a value set
 * workspace-wide — by the config's variables or a workspace `.env` file — and only a file of the
 * service's own replaces them. Excludes `process.env` — merge
 * this over it at spawn time (`Object.assign({}, process.env, layer)`). Shared by the TUI/plain
 * session and `stackctl exec` so both build the same env.
 */
export function packageEnvLayer(
  pkg: AnyServiceConfig,
  opts: EnvLayerOptions,
): Record<string, string> {
  const { read, extraCaCerts, ...rest } = opts;
  const { env, packageNames } = resolveEnvFrom({ ...rest, relativeDir: pkg.relativeDir }, read);
  const injected: Record<string, string> = {};
  if (pkg.port !== undefined) {
    injected.PORT = String(pkg.port);
  }
  if (pkg.publicOrigin !== undefined) {
    injected.PUBLIC_ORIGIN = pkg.publicOrigin;
  }
  if (extraCaCerts !== undefined) {
    injected.NODE_EXTRA_CA_CERTS = extraCaCerts;
  }
  for (const [name, value] of Object.entries(injected)) {
    if (!packageNames.has(name)) {
      env[name] = value;
    }
  }
  return withInjectedList(env);
}

/**
 * The environment layer for what belongs to no service — infra, and `stackctl exec` / `run`
 * outside every service: the config's own variables and the workspace-scope `.env` files,
 * resolved together, with `extraCaCerts` as `NODE_EXTRA_CA_CERTS` unless a file sets it.
 * Excludes `process.env`, like {@link packageEnvLayer}.
 */
export function workspaceEnvLayer(opts: EnvLayerOptions): Record<string, string> {
  const { read, extraCaCerts, ...rest } = opts;
  const { env, packageNames } = resolveEnvFrom({ ...rest, relativeDir: '.' }, read);
  if (extraCaCerts !== undefined && !packageNames.has('NODE_EXTRA_CA_CERTS')) {
    env.NODE_EXTRA_CA_CERTS = extraCaCerts;
  }
  return withInjectedList(env);
}

/**
 * The environment layer for a directory that is no service: the config's own variables and the
 * `.env` files of the workspace and of `relativeDir`, resolved together — service-scoped
 * additional files included — with `extraCaCerts` as `NODE_EXTRA_CA_CERTS` unless a file sets it.
 * No `PORT` and no `PUBLIC_ORIGIN`. Excludes `process.env`, like {@link packageEnvLayer}.
 */
export function directoryEnvLayer(
  relativeDir: string,
  opts: EnvLayerOptions,
): Record<string, string> {
  const { read, extraCaCerts, ...rest } = opts;
  const { env, packageNames } = resolveEnvFrom({ ...rest, relativeDir }, read);
  if (extraCaCerts !== undefined && !packageNames.has('NODE_EXTRA_CA_CERTS')) {
    env.NODE_EXTRA_CA_CERTS = extraCaCerts;
  }
  return withInjectedList(env);
}

/** The environment layer for a resolved target: its service's, the workspace's, or its directory's. */
export function targetEnvLayer(
  target: ResolvedTarget,
  opts: EnvLayerOptions,
): Record<string, string> {
  switch (target.kind) {
    case 'service':
      return packageEnvLayer(target.service, opts);
    case 'root':
      return workspaceEnvLayer(opts);
    case 'directory':
      return directoryEnvLayer(target.relativeDir, opts);
  }
}
