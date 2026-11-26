import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';

/** The file names Compose looks for, in its order of preference. */
const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
];
const COMPOSE_OVERRIDE_FILE_NAMES = [
  'compose.override.yml',
  'compose.override.yaml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
];

/**
 * The Compose project name for a workspace and profile, the first of:
 *
 * 1. `COMPOSE_PROJECT_NAME` from the resolved environment, as it is.
 * 2. The compose file's top-level `name:`, interpolated and normalized as Compose does.
 * 3. `<workspace directory name>-<profile>`, normalized to Compose's rule (lowercase letters,
 *    digits, dashes and underscores, starting with a letter or digit).
 *
 * The first two are names the repo chose, so they are kept: a different name is a different
 * Compose project, and the repo's existing containers would be left behind. The profile is part of
 * the third on purpose: Compose's default is the directory name alone, so two profiles would
 * share one project and bringing one up would recreate the other's containers.
 *
 * `file` is the `docker-compose` provider's `file`, absolute; without it, the files are found as
 * Compose finds them for the commands stackctl runs (in the workspace root, with
 * `--project-directory` set to it).
 */
export function composeProjectName(opts: {
  envs: Record<string, string>;
  workspaceDir: string;
  profile: string;
  file?: string;
}): string {
  const fromEnv = opts.envs.COMPOSE_PROJECT_NAME;
  if (fromEnv) {
    return fromEnv;
  }
  const fromFile = composeFileProjectName(opts);
  if (fromFile) {
    return fromFile;
  }
  return `${path.basename(path.resolve(opts.workspaceDir))}-${opts.profile}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '');
}

/**
 * The top-level `name:` of the compose files Compose would read, or `undefined` when none sets
 * one. Mirrors Compose (compose-go's `projectName`): the last file, and in it the last document,
 * that sets a non-empty `name` wins; it is then interpolated with `envs` and normalized. A file
 * that can't be read or parsed, a `name` that isn't a string, and one that can't be interpolated
 * (a malformed `${`, a required variable with no value) name nothing here: Compose itself reports
 * each on its first command, `COMPOSE_PROJECT_NAME` or not, and the config must still load for
 * the commands that never run Compose. A `name` that interpolates to nothing, which Compose would
 * refuse, leaves the derived name too.
 */
function composeFileProjectName(opts: {
  envs: Record<string, string>;
  workspaceDir: string;
  file?: string;
}): string | undefined {
  let name = '';
  for (const file of composeFiles(opts)) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // As Compose reads a file: aliases and `<<` merge keys resolved, and a document it can't
    // decode the end of the file.
    for (const doc of parseAllDocuments(source, { merge: true })) {
      if (doc.errors.length > 0) {
        break;
      }
      let contents: unknown;
      try {
        contents = doc.toJS();
      } catch {
        break;
      }
      const value = (contents as { name?: unknown } | null | undefined)?.name;
      if (typeof value === 'string' && value !== '') {
        name = value;
      }
    }
  }
  try {
    return normalizeProjectName(interpolate(name, opts.envs)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The compose files Compose reads, in order: `file` when the config names one; else the files in
 * `COMPOSE_FILE` (relative to the workspace root, where stackctl runs Compose); else the first of
 * Compose's file names in the workspace root or the nearest directory above it that has one,
 * with that directory's override file.
 */
function composeFiles(opts: {
  envs: Record<string, string>;
  workspaceDir: string;
  file?: string;
}): string[] {
  if (opts.file !== undefined) {
    return [opts.file];
  }
  const fromEnv = opts.envs.COMPOSE_FILE;
  // Set but empty is still set, as in Compose: its one empty entry is the directory itself, which
  // can't be read, so it names nothing, and Compose fails on it.
  if (fromEnv !== undefined) {
    const separator = opts.envs.COMPOSE_PATH_SEPARATOR || path.delimiter;
    return fromEnv.split(separator).map((entry) => path.resolve(opts.workspaceDir, entry));
  }
  let dir = path.resolve(opts.workspaceDir);
  for (;;) {
    const found = COMPOSE_FILE_NAMES.map((name) => path.join(dir, name)).find(isFile);
    if (found) {
      const override = COMPOSE_OVERRIDE_FILE_NAMES.map((name) => path.join(dir, name)).find(isFile);
      return override ? [found, override] : [found];
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return [];
    }
    dir = parent;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Compose's rule for a name it reads from a file: lowercased, other characters dropped. */
function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '');
}

/**
 * Compose's variable interpolation, for the one value read here: `$$`, `$VAR`, `${VAR}`, and
 * `${VAR}` with `:-`/`-` (a default), `:+`/`+` (a replacement) or `:?`/`?` (required), whose
 * operand is itself interpolated. A variable that isn't set is blank, and a `$` that starts no
 * variable is kept, as in Compose. Throws where Compose fails: a malformed `${`, or a required
 * variable with no value.
 */
function interpolate(template: string, envs: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const dollar = template.indexOf('$', i);
    if (dollar === -1) {
      return out + template.slice(i);
    }
    out += template.slice(i, dollar);
    const next = template[dollar + 1];
    if (next === '$') {
      out += '$';
      i = dollar + 2;
      continue;
    }
    if (next === '{') {
      const close = closingBrace(template, dollar + 1);
      if (close === -1) {
        throw new Error(`invalid interpolation format: ${template}`);
      }
      out += substitute(template.slice(dollar + 2, close), envs);
      i = close + 1;
      continue;
    }
    const named = /^[_a-z][_a-z0-9]*/i.exec(template.slice(dollar + 1));
    if (!named) {
      // A `$` that starts no variable stays as it is.
      out += '$';
      i = dollar + 1;
      continue;
    }
    out += lookup(envs, named[0]) ?? '';
    i = dollar + 1 + named[0].length;
  }
  return out;
}

/** The index of the `}` closing the `{` at `open`, counting the `${` nested in an operand. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') {
      depth++;
    } else if (s[i] === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function lookup(envs: Record<string, string>, variable: string): string | undefined {
  return Object.hasOwn(envs, variable) ? envs[variable] : undefined;
}

/** One `${…}`'s body, as Compose resolves it. */
function substitute(body: string, envs: Record<string, string>): string {
  const match = /^([_a-z][_a-z0-9]*)(?:(:?[-+?])([\s\S]*))?$/i.exec(body);
  if (!match) {
    throw new Error(`invalid interpolation format: \${${body}}`);
  }
  const variable = match[1] ?? '';
  const operator = match[2];
  const operand = match[3] ?? '';
  const value = lookup(envs, variable);
  const nonEmpty = value !== undefined && value !== '';
  switch (operator) {
    case ':-':
      return nonEmpty ? value : interpolate(operand, envs);
    case '-':
      return value ?? interpolate(operand, envs);
    case ':+':
      return nonEmpty ? interpolate(operand, envs) : (value ?? '');
    case '+':
      return value === undefined ? '' : interpolate(operand, envs);
    case ':?':
    case '?':
      if (value === undefined || (operator === ':?' && value === '')) {
        throw new Error(`required variable ${variable} is missing a value`);
      }
      return value;
    default:
      return value ?? '';
  }
}
