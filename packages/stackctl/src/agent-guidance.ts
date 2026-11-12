import fs from 'node:fs';
import path from 'node:path';
import {
  installRules,
  readAgentsBlock,
  refreshAgentsBlockIfStale,
  refreshRulesIfStale,
  rulesInstallPath,
  writeAgentsBlock,
} from './agent-rules.js';
import { stateDirOf } from './log-files.js';
import {
  installSkill,
  readInstalledSkill,
  refreshSkillIfStale,
  skillInstallPath,
} from './skill.js';

/**
 * What tells a coding agent about stackctl in a repo, and how it gets there.
 *
 * - **The rules file and the skill** are stackctl's own files under `.claude/`. A person is
 *   offered them the first time they start a session in a terminal; `stackctl init` installs
 *   them too, and is the way for a script. Nothing installs them unasked.
 * - **The `AGENTS.md` section** edits a file of the project's, so it is never offered: only
 *   `stackctl init --agents-md` writes it.
 * - **Once installed, a file is kept current** without asking, as long as nobody edited it.
 * - **pnpm can link the skill itself** (`pnpm approve`, from the `skills/` folder the package
 *   ships). Where its link is there, stackctl writes no copy of its own.
 */
export interface GuidanceState {
  /** `linked`: pnpm (or another tool) linked the skill out of the installed package. */
  skill: 'installed' | 'linked' | 'missing';
  rules: boolean;
  block: boolean;
}

/**
 * A skill under `.claude/skills/` that is a link into the installed stackctl package, as
 * `pnpm approve` makes one (`pnpm-stackctl-stackctl`, or `stackctl` from pnpm 12.18).
 */
export function linkedSkill(cwd: string): string | null {
  const dir = path.join(cwd, '.claude', 'skills');
  let installed: string;
  let entries: string[];
  try {
    installed = fs.realpathSync(path.join(cwd, 'node_modules', 'stackctl'));
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const entry = path.join(dir, name);
    try {
      if (
        fs.lstatSync(entry).isSymbolicLink() &&
        fs.realpathSync(entry).startsWith(path.join(installed, 'skills') + path.sep)
      ) {
        return entry;
      }
    } catch {
      // a link that leads nowhere is no skill
    }
  }
  return null;
}

export function guidanceState(cwd: string): GuidanceState {
  return {
    skill: linkedSkill(cwd) ? 'linked' : fs.existsSync(skillInstallPath(cwd)) ? 'installed' : 'missing', // oxfmt-ignore
    rules: fs.existsSync(rulesInstallPath(cwd)),
    block: readAgentsBlock(cwd) !== null,
  };
}

/** Whether one of stackctl's own files is not there. */
export const missesOwnFiles = (state: GuidanceState) => !state.rules || state.skill === 'missing';

// ── a "no", remembered ────────────────────────────────────────────────────────────────────────

/**
 * Where a declined offer is remembered: in the workspace's state directory, so per checkout.
 * The files themselves are committed, so a teammate who accepts settles it for everyone; one
 * who declines is the only one not asked again.
 */
function declinedFile(cwd: string): string {
  return path.join(stateDirOf(cwd), 'agent-guidance.json');
}

export function hasDeclined(cwd: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(declinedFile(cwd), 'utf8')) as { declined?: unknown };
    return record.declined === true;
  } catch {
    return false;
  }
}

export function recordDeclined(cwd: string): void {
  try {
    fs.mkdirSync(path.dirname(declinedFile(cwd)), { recursive: true });
    fs.writeFileSync(declinedFile(cwd), `${JSON.stringify({ declined: true })}\n`);
  } catch {
    // not remembered: the offer comes again
  }
}

// ── installing and keeping current ────────────────────────────────────────────────────────────

/**
 * Writes what was chosen: stackctl's own files (the rules file, and the skill unless one is
 * linked), the `AGENTS.md` section, or both. Returns a line per thing it did.
 */
export function installGuidance(opts: {
  cwd: string;
  version: string;
  own: boolean;
  agentsMd: boolean;
}): string[] {
  const { cwd, version } = opts;
  const done: string[] = [];
  if (opts.own) {
    const before = guidanceState(cwd);
    installRules({ cwd, version });
    if (before.skill === 'linked') {
      done.push(before.rules ? 'Updated agent rules file' : 'Installed agent rules file');
    } else {
      installSkill({ cwd, version });
      done.push(
        before.rules && before.skill === 'installed'
          ? 'Updated agent skill and rules file'
          : 'Installed agent skill and rules file',
      );
    }
  }
  if (opts.agentsMd) {
    const outcome = writeAgentsBlock({ cwd, version });
    done.push(
      { created: 'Created AGENTS.md', added: 'Added a stackctl section to AGENTS.md', updated: 'Updated the stackctl section of AGENTS.md' }[outcome], // oxfmt-ignore
    );
  }
  return done;
}

/**
 * Brings what is installed up to `version`: each file an older version wrote and nobody edited
 * since. Installs nothing that is missing. Where the skill is linked, stackctl's own copy of it
 * goes, if it is still as stackctl wrote it: two copies would list the skill twice. Returns the
 * files it changed.
 */
export function refreshGuidance(opts: { cwd: string; version: string }): string[] {
  const { cwd } = opts;
  const changed = [...refreshSkillIfStale(opts), ...refreshRulesIfStale(opts)];
  if (refreshAgentsBlockIfStale(opts)) {
    changed.push(path.join(cwd, 'AGENTS.md'));
  }
  const own = skillInstallPath(cwd);
  const ownDir = path.dirname(own);
  if (
    linkedSkill(cwd) &&
    !fs.lstatSync(ownDir, { throwIfNoEntry: false })?.isSymbolicLink() &&
    readInstalledSkill(own)?.unedited
  ) {
    fs.rmSync(own);
    if (fs.readdirSync(ownDir).length === 0) {
      fs.rmdirSync(ownDir);
    }
    changed.push(own);
  }
  return changed;
}

// ── the offer ─────────────────────────────────────────────────────────────────────────────────

/**
 * Asks one question, whether to install stackctl's own files, and installs them on a yes.
 * Returns what it did, or `null` on a no, which is remembered so a session's start doesn't ask
 * again.
 */
export async function offerGuidance(opts: {
  cwd: string;
  version: string;
}): Promise<string[] | null> {
  const linked = guidanceState(opts.cwd).skill === 'linked';
  // loaded here, so a start that asks nothing (headless, an agent's) never loads the prompts
  const { confirm, isCancel } = await import('@clack/prompts');
  const yes = await confirm({
    message: `Tell coding agents about stackctl in this repo? (${linked ? 'a rules file' : 'a rules file and a skill'} under .claude/)`,
    initialValue: true,
  });
  if (isCancel(yes) || !yes) {
    recordDeclined(opts.cwd);
    return null;
  }
  return installGuidance({ ...opts, own: true, agentsMd: false });
}

/**
 * A session's start: keeps what is installed current, and, when a person is at a terminal and
 * one of stackctl's own files is missing, offers them once. An agent, a script or CI is never
 * asked and gets nothing installed.
 */
export async function guidanceAtStart(opts: {
  cwd: string;
  version: string;
  /** A person at a terminal started this, with the terminal UI ahead. */
  interactive: boolean;
}): Promise<void> {
  refreshGuidance(opts);
  if (!opts.interactive || hasDeclined(opts.cwd) || !missesOwnFiles(guidanceState(opts.cwd))) {
    return;
  }
  const done = await offerGuidance(opts);
  if (done) {
    const { log } = await import('@clack/prompts');
    for (const line of done) {
      log.step(line);
    }
  }
}
