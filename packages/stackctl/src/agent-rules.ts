import fs from 'node:fs';
import path from 'node:path';
import { contentHash, isOlder } from './skill.js';

/**
 * The always-on text: a few lines that say what stackctl runs in this repo and where its docs
 * are. It goes in two places (`agent-guidance.ts` decides when), each read at the start of
 * every session:
 *
 * - `.claude/rules/stackctl.md`, a file of stackctl's own, which Claude Code loads whether the
 *   repo has a `CLAUDE.md` or not;
 * - a marked block in `AGENTS.md`, for the agents that read that file.
 *
 * The skill is found only when an agent decides a task is stackctl's business. This text needs
 * no such decision, which is what keeps an agent from going around stackctl (a `kill`, a bare
 * `docker compose`) on a task that doesn't look like stackctl's.
 * `maintenance/docs/agent-guidance-experiment.md` has the measurements behind it.
 */
function rulesText(): string {
  const file = path.join(import.meta.dirname, '../assets/agent-rules.md');
  return `${fs.readFileSync(file, 'utf8').trim()}\n`;
}

// ── .claude/rules/stackctl.md ─────────────────────────────────────────────────────────────────

/**
 * The rules file's first line: version and a hash of the rest, in an HTML comment, which Claude
 * Code leaves out of what it gives the model.
 */
const RULES_BANNER_RE =
  /^<!-- stackctl rules v(\S+) sha256:([0-9a-f]{64}) — managed by stackctl init; do not edit -->$/;

export function renderRules(version: string): string {
  const body = rulesText();
  return `<!-- stackctl rules v${version} sha256:${contentHash(body)} — managed by stackctl init; do not edit -->\n${body}`;
}

/** Where the rules file is installed (`.claude/rules/stackctl.md`). */
export function rulesInstallPath(cwd: string): string {
  return path.join(cwd, '.claude', 'rules', 'stackctl.md');
}

/**
 * What an installed rules file says about itself, or `null` when it is missing or carries no
 * managed banner. `unedited` is whether the rest of the file still hashes to the banner's hash.
 */
export function readInstalledRules(
  filePath: string,
): { version: string; unedited: boolean } | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const newline = text.indexOf('\n');
  const match = RULES_BANNER_RE.exec(newline === -1 ? text : text.slice(0, newline));
  if (!match) {
    return null;
  }
  return { version: match[1]!, unedited: contentHash(text.slice(newline + 1)) === match[2] };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** `stackctl init`'s install: writes the rules file, whatever is there. Returns its path. */
export function installRules(opts: { cwd?: string; version: string }): string {
  const file = rulesInstallPath(opts.cwd ?? process.cwd());
  writeFile(file, renderRules(opts.version));
  return file;
}

/**
 * Rewrites the rules file when its banner says an older version than `version` and nobody has
 * edited it since. One with no banner, or a hand-edited one, is left alone. Returns the files
 * rewritten.
 */
export function refreshRulesIfStale(opts: { cwd?: string; version: string }): string[] {
  const file = rulesInstallPath(opts.cwd ?? process.cwd());
  const installed = readInstalledRules(file);
  if (!installed?.unedited || !isOlder(installed.version, opts.version)) {
    return [];
  }
  writeFile(file, renderRules(opts.version));
  return [file];
}

// ── the AGENTS.md block ───────────────────────────────────────────────────────────────────────

const BLOCK_RE = /<!-- BEGIN:stackctl v(\S+) [^>]*-->\n[\s\S]*?<!-- END:stackctl -->\n?/;

/** The block: the same text under a second-level heading, between two markers. */
export function renderAgentsBlock(version: string): string {
  const body = rulesText().replace(/^# /, '## ');
  return `<!-- BEGIN:stackctl v${version} (managed by stackctl init: edits in here are overwritten) -->\n${body}<!-- END:stackctl -->\n`;
}

export function agentsFilePath(cwd: string): string {
  return path.join(cwd, 'AGENTS.md');
}

/** The version that wrote `AGENTS.md`'s stackctl block, or `null` when it has none. */
export function readAgentsBlock(cwd: string): { version: string } | null {
  try {
    const match = BLOCK_RE.exec(fs.readFileSync(agentsFilePath(cwd), 'utf8'));
    return match ? { version: match[1]! } : null;
  } catch {
    return null;
  }
}

/**
 * Puts the block in `AGENTS.md`: in place of the one already there, at the end of a file that
 * has none, or in a new file. Everything outside the markers is left as it is.
 */
export function writeAgentsBlock(opts: {
  cwd?: string;
  version: string;
}): 'created' | 'added' | 'updated' {
  const file = agentsFilePath(opts.cwd ?? process.cwd());
  const block = renderAgentsBlock(opts.version);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.writeFileSync(file, block);
    return 'created';
  }
  if (BLOCK_RE.test(text)) {
    // a function, so a `$` in the block is never read as a replacement pattern
    fs.writeFileSync(
      file,
      text.replace(BLOCK_RE, () => block),
    );
    return 'updated';
  }
  const gap = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'; // oxfmt-ignore
  fs.writeFileSync(file, `${text}${gap}${block}`);
  return 'added';
}

/**
 * Rewrites the block when an older version than `version` wrote it. A file with no block is
 * never given one here: only `stackctl init` adds it. Returns whether it was rewritten.
 */
export function refreshAgentsBlockIfStale(opts: { cwd?: string; version: string }): boolean {
  const cwd = opts.cwd ?? process.cwd();
  const installed = readAgentsBlock(cwd);
  if (!installed || !isOlder(installed.version, opts.version)) {
    return false;
  }
  writeAgentsBlock({ cwd, version: opts.version });
  return true;
}
