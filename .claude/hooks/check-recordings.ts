#!/usr/bin/env node
// A Claude Code PreToolUse hook on `git commit` (.claude/settings.json): stops a commit whose
// changes may alter one of the docs' terminal recordings (scripts/demo/scenes.ts) without
// re-recording it, and points at the /commit skill, which judges and re-records.
//
// A recording counts as re-recorded when the changes carry a new cast for its scene
// (docs/public/casts/<scene>-<ts>.cast). When the skill judged that a listed scene doesn't really
// change (a comment, an edit the screen never shows), the commit goes through with
// `STACKCTL_RECORDINGS_CHECKED=1` in front of it.
//
// The commit is checked in the checkout it runs in: `git -C <dir>`, or a leading `cd <dir> &&`,
// or the session's working directory. Exit 2 blocks the command and shows stderr to Claude.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { affectedScenes, changedFiles } from '../../scripts/demo/affected.ts';

const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
  cwd?: string;
  tool_input?: { command?: string };
};
const command = input.tool_input?.command ?? '';

if (
  !/\bgit\b(?:\s+-C\s+\S+)?\s+commit\b/.test(command) ||
  /\bSTACKCTL_RECORDINGS_CHECKED=1\b/.test(command)
) {
  process.exit(0);
}

const unquote = (text: string) => text.replace(/^(['"])(.*)\1$/, '$2');
const dir =
  /\bgit\s+-C\s+(\S+)\s+commit\b/.exec(command)?.[1] ??
  /^\s*cd\s+(\S+)\s*&&/.exec(command)?.[1] ??
  input.cwd ??
  process.cwd();

let root: string;
try {
  root = execFileSync('git', ['-C', unquote(dir), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
} catch {
  process.exit(0);
}
// Another repository's commit is none of this hook's business.
if (!fs.existsSync(path.join(root, 'scripts/demo/scenes.ts'))) {
  process.exit(0);
}

const changed = changedFiles('HEAD', root);
const stale = affectedScenes(changed).filter(
  ({ scene }) =>
    !changed.some((file) => new RegExp(`^docs/public/casts/${scene}-\\d+\\.cast$`).test(file)),
);
if (stale.length === 0) {
  process.exit(0);
}

process.stderr.write(
  [
    'This commit may alter recordings it does not re-record:',
    ...stale.map(({ scene, files }) => `  ${scene}: ${files.join(', ')}`),
    '',
    'Follow the /commit skill (.claude/skills/commit/SKILL.md): judge from the diff whether each',
    'really changes, re-record those with ./scripts/demo/record.sh <scene>, then commit again.',
    'If none of them really changes, say why to the user and commit with',
    'STACKCTL_RECORDINGS_CHECKED=1 in front of the git commit.',
    '',
  ].join('\n'),
);
process.exit(2);
