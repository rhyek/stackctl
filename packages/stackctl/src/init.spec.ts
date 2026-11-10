import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { runInit } from './init.js';
import { readInstalledSkill, readOwnVersion } from './skill.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-init-'));
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('runInit --yes (non-interactive)', () => {
  test('scaffolds the config, reconciles tsconfig, and installs the skill without prompting', async () => {
    await runInit({ cwd, yes: true });
    expect(fs.existsSync(path.join(cwd, 'stackctl.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.claude/skills/stackctl/SKILL.md'))).toBe(true);
  });

  test('is idempotent: keeps the existing config and does not duplicate the tsconfig include', async () => {
    await runInit({ cwd, yes: true });
    const config = fs.readFileSync(path.join(cwd, 'stackctl.config.ts'), 'utf8');

    await runInit({ cwd, yes: true });
    // An existing config is left untouched.
    expect(fs.readFileSync(path.join(cwd, 'stackctl.config.ts'), 'utf8')).toBe(config);
    // stackctl.config.ts appears exactly once in tsconfig's include.
    const ts = fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8');
    expect((ts.match(/stackctl\.config\.ts/g) ?? []).length).toBe(1);
  });
});

describe('runInit skill auto-update', () => {
  test('refreshes an already-installed skill without prompting (no --yes)', async () => {
    // First-time install (via --yes) so the managed skill file exists.
    await runInit({ cwd, yes: true });
    const file = path.join(cwd, '.claude/skills/stackctl/SKILL.md');
    // Simulate the on-disk skill drifting from the shipped template.
    fs.writeFileSync(file, 'STALE\n');

    // No --yes: because the skill already exists, init must refresh it WITHOUT prompting
    // (this would hang on the confirm() prompt if the auto-update path weren't taken).
    await runInit({ cwd });

    const out = fs.readFileSync(file, 'utf8');
    expect(out).not.toContain('STALE');
    expect(out).toContain('stackctl skill v');
  });
});

describe('runInit rewrites the managed copies only', () => {
  const agents = () => path.join(cwd, '.agents/skills/stackctl/SKILL.md');
  const cursor = () => path.join(cwd, '.cursor/skills/stackctl/SKILL.md');
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  test('rewrites an .agents or .cursor copy with a managed banner, hand-edited or not', async () => {
    write(agents(), '---\n# stackctl skill v0.6.0 — managed by `stackctl init`; do not edit\nname: stackctl\n---\nold\n'); // oxfmt-ignore
    fs.mkdirSync(path.join(cwd, '.cursor'));
    await runInit({ cwd, yes: true });
    fs.appendFileSync(cursor(), 'HAND EDIT\n');
    expect(readInstalledSkill(cursor())?.unedited).toBe(false);

    await runInit({ cwd, yes: true });
    expect(readInstalledSkill(agents())).toEqual({ version: readOwnVersion(), unedited: true });
    expect(readInstalledSkill(cursor())).toEqual({ version: readOwnVersion(), unedited: true });
  });

  test('rewrites a copy with the HTML-comment banner', async () => {
    write(cursor(), '<!-- stackctl skill v0.5.0 — managed by `stackctl init`; do not edit -->\n---\nname: stackctl\n---\nold\n'); // oxfmt-ignore
    await runInit({ cwd, yes: true });
    expect(readInstalledSkill(cursor())).toEqual({ version: readOwnVersion(), unedited: true });
  });

  test('never touches a copy with no banner', async () => {
    write(agents(), '---\nname: stackctl\n---\nmine\n');
    await runInit({ cwd, yes: true });
    expect(fs.readFileSync(agents(), 'utf8')).toBe('---\nname: stackctl\n---\nmine\n');
    expect(fs.existsSync(path.join(cwd, '.claude/skills/stackctl/SKILL.md'))).toBe(true);
  });
});
