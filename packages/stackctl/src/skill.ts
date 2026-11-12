import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The managed banner, in both the shape we write now and the one we used to.
 *
 * The old form was an HTML comment ABOVE the frontmatter, and it silently broke every install:
 * YAML frontmatter has to begin on line 1, so a comment in front of it means the block is never
 * parsed as frontmatter at all. The agent then sees the banner text where the `description`
 * should be — i.e. the one field that decides whether the skill is ever invoked became the
 * sentence "do not edit". The skill was undiscoverable in every repo it had been installed into.
 *
 * Both forms are stripped so an existing file is migrated rather than accumulating banners.
 */
const BANNER_RE =
  /^(?:<!-- stackctl skill v.*? — managed by `stackctl init`; do not edit -->\n+|# stackctl skill v.*? — managed by `stackctl init`; do not edit\n)/;

/**
 * The banner we write now: version and a hash of the rest of the file, as a YAML comment on line 2.
 * A file carrying only an earlier banner has no `sha256:`, so it counts as unmanaged.
 */
const MANAGED_BANNER_RE =
  /^# stackctl skill v(\S+) sha256:([0-9a-f]{64}) — managed by stackctl init; do not edit$/;

function banner(version: string, hash: string): string {
  return `# stackctl skill v${version} sha256:${hash} — managed by stackctl init; do not edit`;
}

/**
 * Reads the shipped `skills/stackctl/SKILL.md` and renders it with the managed banner. The file
 * sits where pnpm looks for a dependency's skills (`skills/<name>/SKILL.md`), so `pnpm approve`
 * can link it as it is; this copy, with its banner, is what stackctl writes itself.
 *
 * The banner goes INSIDE the frontmatter, as a YAML comment on the line after the opening `---`.
 * That keeps it the first thing a human sees when they open the file — which is the whole point of
 * a "do not edit" notice — while the YAML parser drops it, so it costs nothing and cannot be
 * mistaken for content. Putting it above the frontmatter is what broke discovery; putting it below
 * the closing `---` would work too, but a reader would meet it after the metadata rather than
 * before, and it would be loaded as part of the skill body.
 *
 * The banner's hash is the SHA-256 of the rendered file without the banner line, so the installed
 * file alone says which version wrote it and whether anyone has edited it since.
 */
export function renderSkill(version: string): string {
  const templatePath = path.join(import.meta.dirname, '../skills/stackctl/SKILL.md');
  const template = fs.readFileSync(templatePath, 'utf8').replace(BANNER_RE, '');

  if (!template.startsWith('---\n')) {
    throw new Error('skills/stackctl/SKILL.md must open with YAML frontmatter on line 1');
  }
  const unbannered = template;
  const hash = contentHash(unbannered);
  return `---\n${banner(version, hash)}\n` + unbannered.slice('---\n'.length);
}

/**
 * What an installed skill file says about itself, or `null` when it is missing or carries no
 * managed banner. `unedited` is whether the rest of the file still hashes to the banner's hash.
 */
export function readInstalledSkill(
  filePath: string,
): { version: string; unedited: boolean } | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const match = lines[0] === '---' ? MANAGED_BANNER_RE.exec(lines[1] ?? '') : null;
  if (!match) {
    return null;
  }
  const rest = [lines[0], ...lines.slice(2)].join('\n');
  return { version: match[1]!, unedited: contentHash(rest) === match[2] };
}

export function contentHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Reads stackctl's own version (for the skill banner). Falls back to '0.0.0'. */
export function readOwnVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `true` when `a` is an older semver-ish (`x.y.z`) version than `b`. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) {
      return na < nb;
    }
  }
  return false;
}

function writeSkillFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// Best-effort secondary install targets: mirrored under any of these dirs
// that already exist, alongside the canonical `.claude/` install.
const OPTIONAL_DIRS = ['.agents', '.cursor'];

/** Canonical install path for the managed skill file (`.claude/skills/stackctl/SKILL.md`). */
export function skillInstallPath(cwd: string): string {
  return path.join(cwd, '.claude', 'skills', 'stackctl', 'SKILL.md');
}

/** `true` when the managed skill file is already installed at `cwd`. */
export function isSkillInstalled(cwd: string): boolean {
  return fs.existsSync(skillInstallPath(cwd));
}

/** Every place the skill is (or would be) installed: canonical first, then the optional dirs. */
function installTargets(cwd: string): string[] {
  return [
    skillInstallPath(cwd),
    ...OPTIONAL_DIRS.map((dir) => path.join(cwd, dir, 'skills', 'stackctl', 'SKILL.md')),
  ];
}

/** Whether `text` carries a managed banner in any form stackctl has written: see {@link BANNER_RE}. */
function hasManagedBanner(text: string): boolean {
  const lines = text.split('\n');
  return (
    /^<!-- stackctl skill v.*? — managed by `stackctl init`; do not edit -->$/.test(
      lines[0] ?? '',
    ) ||
    (lines[0] === '---' &&
      (/^# stackctl skill v.*? — managed by `stackctl init`; do not edit$/.test(lines[1] ?? '') ||
        MANAGED_BANNER_RE.test(lines[1] ?? '')))
  );
}

/** What is at `filePath`: nothing, a copy carrying a managed banner, or a file of someone's own. */
function existingCopy(filePath: string): 'missing' | 'managed' | 'own' {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'own';
  }
  return hasManagedBanner(text) ? 'managed' : 'own';
}

/** The `.agents/` / `.cursor/` copies, for each of those directories that exists. */
function optionalTargets(cwd: string): string[] {
  return OPTIONAL_DIRS.filter((dir) => fs.existsSync(path.join(cwd, dir))).map((dir) =>
    path.join(cwd, dir, 'skills', 'stackctl', 'SKILL.md'),
  );
}

/** Writes `content` to each of `targets` (best-effort); the ones written. */
function writeOptional(targets: string[], content: string): string[] {
  const written: string[] = [];
  for (const target of targets) {
    try {
      writeSkillFile(target, content);
      written.push(target);
    } catch {
      // best-effort: a secondary install target failing shouldn't fail setup.
    }
  }
  return written;
}

/**
 * `stackctl init`'s install: writes the rendered skill to `.claude/skills/stackctl/SKILL.md`
 * (always) and, where `.agents/` / `.cursor/` exist, to a copy there that is missing or carries a
 * managed banner, edited or not (best-effort). A copy there with no banner is never touched. The
 * version and a content hash live in the file's own banner; nothing is recorded elsewhere.
 * Returns the files written.
 */
export function installSkill(opts: { cwd?: string; version: string }): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const content = renderSkill(opts.version);
  writeSkillFile(skillInstallPath(cwd), content);
  const optional = optionalTargets(cwd).filter((target) => existingCopy(target) !== 'own');
  return [skillInstallPath(cwd), ...writeOptional(optional, content)];
}

/**
 * Rewrites each installed copy (`.claude/`, and `.agents/`/`.cursor/` where present) whose
 * banner says an older version than `version` and whose content still matches the banner's hash.
 * A copy without a managed banner, or one that was hand-edited, is left untouched. Returns the
 * files rewritten.
 */
export function refreshSkillIfStale(opts: { cwd?: string; version: string }): string[] {
  const cwd = opts.cwd ?? process.cwd();
  let content: string | undefined;
  const written: string[] = [];
  for (const target of installTargets(cwd)) {
    const installed = readInstalledSkill(target);
    if (!installed?.unedited || !isOlder(installed.version, opts.version)) {
      continue;
    }
    content ??= renderSkill(opts.version);
    try {
      writeSkillFile(target, content);
      written.push(target);
    } catch {
      // best-effort, as in installSkill.
    }
  }
  return written;
}
