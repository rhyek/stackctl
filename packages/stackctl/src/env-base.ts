import { findPassthrough } from './infra/argv.js';

// What stackctl's environment handling needs without reading a file: the profile, the names and
// order of the `.env` files, the environment stackctl was started with, and what an outer stackctl
// injected. Apart from `env.ts`, which reads and resolves the files, so a command that resolves
// none — `--help`, `logs` — doesn't load the parser that does.

/** The profile used when no flag, `STACKCTL_PROFILE` or CI says otherwise. */
export const DEFAULT_PROFILE = 'development';

/** The profile a CI run defaults to: see {@link isCI}. */
export const CI_PROFILE = 'test';

/**
 * A profile name, as a callback receives it. Any name is a valid profile — `--profile staging`
 * loads `.env.staging` — so this is every string; the two literals are there so an editor offers
 * the usual ones, `development` (the default) and `test`. `string & {}` is what keeps them from
 * being absorbed into plain `string`.
 */
export type Profile = typeof DEFAULT_PROFILE | 'test' | (string & {});

/**
 * Where the profile came from: `--profile`/`-p` (`flag`), `STACKCTL_PROFILE` (`env`), the CI
 * default (`ci`), or neither (`default`). A process a stackctl started inherits `STACKCTL_PROFILE`,
 * so a stackctl it runs reads `env`.
 */
export type ProfileSource = 'flag' | 'env' | 'ci' | 'default';

/**
 * Set (to `1`) in the environment of the session `start --detach` forks: it ends when its IPC
 * channel closes, as a `startStack()` session does, until a {@link RELEASE_MESSAGE} lets it go.
 * The CLI deletes it as it starts.
 */
export const DETACHED_SESSION_VAR = 'STACKCTL_DETACHED_SESSION';

/** The `type` of the message `start --detach` sends its session as it lets go of it. */
export const RELEASE_MESSAGE = 'release';

// Where the CLI's profile came from, kept for its own process only: a process stackctl starts
// inherits `STACKCTL_PROFILE`, so its profile's source is `env`, and it resolves that itself. On
// `globalThis`, like `CLI_PROCESS` below, since the config may import another copy of stackctl.
const PROFILE_SOURCE = Symbol.for('stackctl.profileSource');

/**
 * Records where this process's profile came from; `undefined` forgets it. The CLI calls it once.
 */
export function publishProfileSource(source: ProfileSource | undefined): void {
  (globalThis as Record<symbol, unknown>)[PROFILE_SOURCE] = source;
}

/**
 * Whether this is a CI run: `CI` set and non-empty, and not `false` or `0` (in any case). The one
 * check behind the CI default profile and `start --detach`'s agent refusal.
 */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CI;
  return value !== undefined && value !== '' && !['false', '0'].includes(value.toLowerCase());
}

/**
 * The profile and its source without a flag: `STACKCTL_PROFILE`, else the CI default, else
 * `development`.
 */
function ambientProfile(env: NodeJS.ProcessEnv): { profile: string; source: ProfileSource } {
  if (env.STACKCTL_PROFILE) {
    return { profile: env.STACKCTL_PROFILE, source: 'env' };
  }
  return isCI(env)
    ? { profile: CI_PROFILE, source: 'ci' }
    : { profile: DEFAULT_PROFILE, source: 'default' };
}

/**
 * The active profile. Set once at CLI startup (`resolveProfile`'s result is written to
 * `STACKCTL_PROFILE` before the config is loaded) and read from the environment thereafter, so
 * config callbacks and spawned children agree on it without threading a parameter through every
 * call site. Outside the CLI, with no `STACKCTL_PROFILE`, it is the CI default in CI and
 * `development` otherwise.
 */
export function currentProfile(): Profile {
  return ambientProfile(process.env).profile;
}

/**
 * Where the active profile came from: what the CLI published ({@link publishProfileSource}), else
 * as {@link currentProfile} found it.
 */
export function currentProfileSource(): ProfileSource {
  const published = (globalThis as Record<symbol, unknown>)[PROFILE_SOURCE];
  return isProfileSource(published) ? published : ambientProfile(process.env).source;
}

/** Whether `value` is a {@link ProfileSource}. */
export function isProfileSource(value: unknown): value is ProfileSource {
  return value === 'flag' || value === 'env' || value === 'ci' || value === 'default';
}

/**
 * How a message names a profile's source: `from --profile`, `from STACKCTL_PROFILE`, `CI default`,
 * `default`.
 */
export function describeProfileSource(source: ProfileSource): string {
  switch (source) {
    case 'flag':
      return 'from --profile';
    case 'env':
      return 'from STACKCTL_PROFILE';
    case 'ci':
      return 'CI default';
    case 'default':
      return 'default';
  }
}

/**
 * The session's first line: `profile <profile> (<source>)`, e.g. `profile test (from --profile)`.
 */
export function profileLine(): string {
  return `profile ${currentProfile()} (${describeProfileSource(currentProfileSource())})`;
}

/**
 * Rejects a profile name that couldn't safely become part of a filename. A profile is interpolated
 * straight into `.env.<profile>`, so `--profile ../../etc` must be an error rather than a path
 * traversal. Dots *within* a name stay legal — `--profile e2e.ci` resolves `.env.e2e.ci`.
 */
export function assertValidProfile(profile: string): string {
  if (!profile || profile === '.' || profile === '..' || /[/\\]/.test(profile)) {
    throw new Error(
      `invalid --profile ${JSON.stringify(profile)}: a profile name can't be empty, "." or "..", or contain a path separator`,
    );
  }
  return profile;
}

/**
 * The profile for this invocation and where it came from, read from raw argv before Commander
 * parses anything — the config is loaded (and its `port`/`urls` callbacks resolve env) earlier than
 * that. In order: `--profile`/`-p`, `STACKCTL_PROFILE`, `test` in CI ({@link isCI}), `development`.
 *
 * **Stops at the first bare `--`.** Everything after it belongs to the command being run:
 * `stackctl exec -- docker compose --profile tools up` passes `--profile tools` to Compose, and
 * must not silently load `.env.tools` here.
 *
 * **And at an `infra <provider>` passthrough**, for the same reason:
 * `stackctl infra docker-compose -p demo ps` hands `-p demo` to Compose.
 */
export function resolveProfile(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { profile: string; source: ProfileSource } {
  const passthrough = findPassthrough(argv);
  const end = passthrough === -1 ? argv.indexOf('--') : passthrough;
  const args = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--profile' || arg === '-p') {
      return { profile: assertValidProfile(args[i + 1] ?? ''), source: 'flag' };
    }
    if (arg.startsWith('--profile=')) {
      return { profile: assertValidProfile(arg.slice('--profile='.length)), source: 'flag' };
    }
  }
  const { profile, source } = ambientProfile(env);
  return { profile: assertValidProfile(profile), source };
}

/**
 * The `.env` filenames for a profile, in ascending precedence *within a scope*: a base `.env`, the
 * developer's `.env.local`, then the profile's `.env.<profile>` and `.env.<profile>.local`. This is
 * Vite's order — a profile file outranks `.env.local`.
 *
 * Profiles are exclusive: `--profile test` loads `.env.test`, never `.env.development`. Values
 * shared across profiles belong in `.env` / `.env.local`, which load in every profile.
 */
export function envFileNames(profile: string = currentProfile()): string[] {
  return ['.env', '.env.local', `.env.${profile}`, `.env.${profile}.local`];
}

/**
 * One of stackctl's own `.env` files, as an additional file names it to say where it goes:
 * `'base'` is `.env`, `'local'` is `.env.local`, `'profile'` is `.env.<profile>` and
 * `'profileLocal'` is `.env.<profile>.local`.
 */
export type EnvFileAnchor = 'base' | 'local' | 'profile' | 'profileLocal';

/** The anchors, in the order their files load: the same order as {@link envFileNames}. */
export const ENV_FILE_ANCHORS: readonly EnvFileAnchor[] = [
  'base',
  'local',
  'profile',
  'profileLocal',
];

/** Where an additional `.env` file is looked for: the workspace root, or a service's directory. */
export type EnvFileScope = 'workspace' | 'service';

/** An additional `.env` file loaded just before one of stackctl's own. */
export interface EnvFileBefore {
  /**
   * The file's name, in the scope's directory: a name, not a path. Only a file that exists is
   * read, like stackctl's own.
   */
  file: string;
  /**
   * The stackctl file this one loads just before. At each scope stackctl loads `.env`,
   * `.env.local`, `.env.<profile>` and `.env.<profile>.local`, in that order, and a later file
   * wins, so this file is outranked by the one it names and everything after it. With
   * `--profile development` and `file: '.env.pre'`:
   *
   * - `'base'`: before `.env`, first and weakest:
   *   `.env.pre`, `.env`, `.env.local`, `.env.development`, `.env.development.local`.
   * - `'local'`: before `.env.local`:
   *   `.env`, `.env.pre`, `.env.local`, `.env.development`, `.env.development.local`.
   * - `'profile'`: before `.env.<profile>`:
   *   `.env`, `.env.local`, `.env.pre`, `.env.development`, `.env.development.local`.
   * - `'profileLocal'`: before `.env.<profile>.local`:
   *   `.env`, `.env.local`, `.env.development`, `.env.pre`, `.env.development.local`.
   *
   * Files on the same anchor load in array order. The workspace's files all load before a
   * service's own (see `scope`).
   */
  before: EnvFileAnchor;
  after?: never;
  /**
   * Where the file is looked for: `'workspace'` (the root only) or `'service'` (a service's own
   * directory only). Unset, it is looked for at both, like stackctl's own files.
   */
  scope?: EnvFileScope;
}

/** An additional `.env` file loaded just after one of stackctl's own. */
export interface EnvFileAfter {
  /**
   * The file's name, in the scope's directory: a name, not a path. Only a file that exists is
   * read, like stackctl's own.
   */
  file: string;
  /**
   * The stackctl file this one loads just after. At each scope stackctl loads `.env`,
   * `.env.local`, `.env.<profile>` and `.env.<profile>.local`, in that order, and a later file
   * wins, so this file outranks the one it names and everything before it. With
   * `--profile development` and `file: '.env.post'`:
   *
   * - `'base'`: after `.env`:
   *   `.env`, `.env.post`, `.env.local`, `.env.development`, `.env.development.local`.
   * - `'local'`: after `.env.local`:
   *   `.env`, `.env.local`, `.env.post`, `.env.development`, `.env.development.local`.
   * - `'profile'`: after `.env.<profile>`:
   *   `.env`, `.env.local`, `.env.development`, `.env.post`, `.env.development.local`.
   * - `'profileLocal'`: after `.env.<profile>.local`, last and strongest:
   *   `.env`, `.env.local`, `.env.development`, `.env.development.local`, `.env.post`.
   *
   * Files on the same anchor load in array order. The workspace's files all load before a
   * service's own (see `scope`).
   */
  after: EnvFileAnchor;
  before?: never;
  /**
   * Where the file is looked for: `'workspace'` (the root only) or `'service'` (a service's own
   * directory only). Unset, it is looked for at both, like stackctl's own files.
   */
  scope?: EnvFileScope;
}

/**
 * An extra `.env` file a project places around stackctl's own: `{ file, before }` or
 * `{ file, after }`, naming one of stackctl's files with an {@link EnvFileAnchor}.
 */
export type EnvAdditionalFile = EnvFileBefore | EnvFileAfter;

/**
 * The `.env` files looked for at each scope, ascending precedence: stackctl's own four for the
 * profile, with a project's additional files placed around them. A service whose directory is the
 * workspace root has no scope of its own: it reads the `workspace` files.
 */
export interface EnvFileOrder {
  /** The files looked for at the workspace root. */
  workspace: string[];
  /** The files looked for in a service's own directory. */
  service: string[];
}

/**
 * The {@link EnvFileOrder} for a profile: at each scope, stackctl's own files in their order, each
 * with the additional files that name it placed around it — those `before` it just ahead of it,
 * those `after` it just behind it, each group in `additional`'s order. So between two of
 * stackctl's files come the files `after` the first, then the files `before` the second.
 * `additional` is taken as already checked: see `defineConfig`.
 */
export function envFileOrder(
  profile: string = currentProfile(),
  additional: readonly EnvAdditionalFile[] = [],
): EnvFileOrder {
  const standard = envFileNames(profile);
  const at = (scope: EnvFileScope): string[] => {
    const here = additional.filter((entry) => (entry.scope ?? scope) === scope);
    return ENV_FILE_ANCHORS.flatMap((anchor, i) => [
      ...here.filter((entry) => entry.before === anchor).map((entry) => entry.file),
      standard[i] ?? '',
      ...here.filter((entry) => entry.after === anchor).map((entry) => entry.file),
    ]);
  };
  return { workspace: at('workspace'), service: at('service') };
}

/** Variables whose file value may beat the ambient environment; `true` means all of them. */
export type EnvOverride = boolean | string[];

/**
 * The hidden CLI command that resolves a one-off command — or, given none, an environment — in a
 * child process, for the SDK's `exec()` and `run()` and for `resolveEnv()`: so
 * the caller never imports the config itself.
 */
export const RESOLVE_ONE_OFF_COMMAND = '__resolve-one-off';

/** The file descriptor {@link RESOLVE_ONE_OFF_COMMAND} writes its result to, as JSON. */
export const RESOLVE_ENV_FD = 3;

// stackctl's own CLI process, marked as it starts and for its whole life: the config and its
// callbacks run in it. On `globalThis`, since the config may import another copy of stackctl than
// the CLI's (a linked one). Not an environment variable, which every command stackctl starts would
// inherit.
const CLI_PROCESS = Symbol.for('stackctl.cliProcess');

/** Marks this process as stackctl's CLI, before it loads the config. */
export function markCliProcess(): void {
  (globalThis as Record<symbol, unknown>)[CLI_PROCESS] = true;
}

/**
 * Throws in stackctl's own CLI process. `resolveEnv()`, `exec()`, `run()` and `startStack()` run
 * the CLI, which loads the config: called from the config, each would start another, without end.
 */
export function assertOutsideCli(fn: string): void {
  if ((globalThis as Record<symbol, unknown>)[CLI_PROCESS] === true) {
    throw new Error(
      `${fn}() can't be called inside stackctl's own process (stackctl.config.ts and its ` +
        "callbacks): set variables with `env.vars`, read them from a callback's `envs`, and run " +
        'a command from an infra callback with its `exec` helper',
    );
  }
}

/**
 * Throws `<fn>: unknown option "<name>"` for a key of `options` not in `allowed`: a JavaScript
 * caller, or a leftover option, bypasses the types.
 */
export function rejectUnknownOptions(
  fn: string,
  options: object,
  allowed: readonly string[],
): void {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) {
      throw new Error(`${fn}: unknown option "${name}"`);
    }
  }
}

/** The variables stackctl sets itself, for the config's callbacks and every process it starts. */
export interface StackctlEnv {
  /**
   * The active profile: `--profile`, else `STACKCTL_PROFILE`, else `test` in CI, else
   * `development`.
   */
  STACKCTL_PROFILE: Profile;
  /** The directory stackctl was invoked in: the workspace root, or wherever below it. */
  STACKCTL_CWD: string;
  /** The workspace root — the directory holding `stackctl.config.ts`. */
  STACKCTL_WORKSPACE_DIR: string;
}

/**
 * The environment a callback receives as `envs`. Any name can be read from it; the variables
 * stackctl sets are spelled out so an editor offers them, and they are always there.
 */
export type Envs = StackctlEnv & Record<string, string>;

/**
 * The ambient environment as a callback's `envs` starts from: with the variables the stackctl
 * CLI publishes filled in for a process it didn't start — a script importing the config, say.
 */
export function baseEnvs(workspaceDir: string): Envs {
  const fallback: StackctlEnv = {
    STACKCTL_PROFILE: currentProfile(),
    STACKCTL_CWD: process.cwd(),
    STACKCTL_WORKSPACE_DIR: workspaceDir,
  };
  return Object.assign(fallback, ambientEnv());
}

/**
 * A snapshot of `process.env` with `undefined`-valued keys dropped, so it can be used as a
 * plain string map. Used as the base layer a service's env files are merged over, and (after
 * {@link hideDollars}) as the `${VAR}`-expansion source in {@link resolveEnvFrom}.
 */
export function ambientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Set by stackctl on every command it runs: a session's dev processes and commands-menu commands,
 * and what `exec` and `run` run. An `exec` or `run` started under it, a dev script's
 * `sctl exec -- node --watch src/main.ts` say, is part of that command, which already logs its
 * output and records it: it only sets up the environment. Taken out by the CLI as it starts
 * ({@link takeNested}), so the command it runs doesn't pass it on.
 */
export const NESTED_ENV_VAR = 'STACKCTL_NESTED';

/** Whether this CLI process was started with {@link NESTED_ENV_VAR}, which {@link takeNested} took out. */
let nestedAtStart = false;

/** Takes {@link NESTED_ENV_VAR} out of `env`, remembering it for {@link isNested}. The CLI calls it first thing. */
export function takeNested(env: NodeJS.ProcessEnv = process.env): void {
  if (env[NESTED_ENV_VAR]) {
    nestedAtStart = true;
  }
  delete env[NESTED_ENV_VAR];
}

/**
 * Whether this process runs inside a command stackctl runs ({@link NESTED_ENV_VAR}): the CLI's
 * as it started, and a script's that calls the SDK as it is now.
 */
export function isNested(env: NodeJS.ProcessEnv = process.env): boolean {
  return nestedAtStart || Boolean(env[NESTED_ENV_VAR]);
}

/**
 * Names, comma-separated, the variables stackctl gave a child that the shell stackctl was started
 * in didn't — the `.env` values, the config's own variables, `PORT`. A stackctl started from such a
 * child (an e2e suite that `stackctl run` started, say) drops them first, so they don't count as
 * its ambient environment and beat its own `.env` files. `STACKCTL_PROFILE` is never listed: a
 * nested stackctl keeps the profile it was started in.
 */
export const INJECTED_ENV_VAR = 'STACKCTL_INJECTED_ENV';

/**
 * The values, as a JSON object, that the shell stackctl was started in had for the variables
 * stackctl gave a child another value for: a `.env` file that `env.override` lets append to the
 * shell's `NODE_OPTIONS`, a `PORT` the shell had set. A stackctl started from such a child gives
 * them these values back ({@link dropInjectedEnv}). Absent when stackctl replaced none.
 */
export const REPLACED_ENV_VAR = 'STACKCTL_REPLACED_ENV';

/** What {@link REPLACED_ENV_VAR} holds: each name's string value, or nothing if it can't be read. */
function replacedEnv(text: string | undefined): Record<string, string> {
  if (text === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Drops what an outer stackctl listed in {@link INJECTED_ENV_VAR}, and the list itself, and
 * gives each variable in {@link REPLACED_ENV_VAR} the value the outer one's shell had for it:
 * what is left is the environment the outer stackctl was started with. The CLI calls it first,
 * before anything reads the environment.
 */
export function dropInjectedEnv(env: NodeJS.ProcessEnv = process.env): void {
  const list = env[INJECTED_ENV_VAR];
  if (list === undefined) {
    return;
  }
  const replaced = replacedEnv(env[REPLACED_ENV_VAR]);
  for (const key of list.split(',')) {
    if (key !== '' && key !== 'STACKCTL_PROFILE') {
      delete env[key];
    }
  }
  delete env[INJECTED_ENV_VAR];
  delete env[REPLACED_ENV_VAR];
  for (const [key, value] of Object.entries(replaced)) {
    if (key !== 'STACKCTL_PROFILE') {
      env[key] = value;
    }
  }
}

/** The environment stackctl was started with, once {@link captureShellEnv} has recorded it. */
let shellEnv: Record<string, string> | undefined;

/**
 * Records the environment as it stands — the one stackctl was started with — as the **ambient
 * environment** every later {@link resolveEnvFrom} resolves against.
 *
 * The CLI calls this once, before it merges the workspace's `.env` files into its own
 * `process.env`. From then on `process.env` holds file values next to the shell's, and nothing
 * in it says which is which — but only a variable the shell set is entitled to win over a file.
 * A workspace file's value that counted as ambient would beat the service file meant to
 * override it, and would keep beating the workspace file itself after an edit.
 */
export function captureShellEnv(): void {
  shellEnv = ambientEnv();
}

/**
 * The environment stackctl was started with ({@link captureShellEnv}), or this process's own
 * when it wasn't recorded — what a stackctl this one starts should get as its own, without the
 * `.env` values this process has merged into `process.env` since.
 */
export function shellEnvironment(): Record<string, string> {
  return { ...(shellEnv ?? ambientEnv()) };
}
