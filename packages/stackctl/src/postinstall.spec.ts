import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { runPostinstall } from './postinstall.js';
import { installSkill, readInstalledSkill, skillInstallPath } from './skill.js';

// A fake consumer project (`root`) with stackctl installed under its node_modules as a symlink
// to a fake package dir — the layout npm and pnpm both produce, once realpath'd.
let root: string;
let packageDir: string;
const log: string[] = [];
const write = (line: string) => void log.push(line);

beforeEach(() => {
  log.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-postinstall-')));
  packageDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-pkg-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "consumer", "private": true }\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(packageDir, path.join(root, 'node_modules', 'stackctl'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(packageDir, { recursive: true, force: true });
});

const run = (env: Record<string, string | undefined> = { INIT_CWD: root }) =>
  runPostinstall({ packageDir, env, version: '1.2.3', write });

describe('runPostinstall', () => {
  test('installs the skill when the project already has a config, leaving the config alone', async () => {
    const config = path.join(root, 'stackctl.config.ts');
    fs.writeFileSync(config, '// my config\n');
    await run();
    expect(fs.readFileSync(config, 'utf8')).toBe('// my config\n');
    expect(fs.existsSync(skillInstallPath(root))).toBe(true);
    expect(fs.readFileSync(skillInstallPath(root), 'utf8')).toContain('1.2.3');
    expect(log.join('\n')).toMatch(/agent skill/);
  });

  test('runs init when the project has no config: scaffolds it and installs the skill', async () => {
    await run();
    expect(fs.existsSync(path.join(root, 'stackctl.config.ts'))).toBe(true);
    expect(fs.existsSync(skillInstallPath(root))).toBe(true);
  });

  test('refreshes an unedited copy an older version wrote', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    installSkill({ cwd: root, version: '1.0.0' });
    await run();
    expect(readInstalledSkill(skillInstallPath(root))).toEqual({
      version: '1.2.3',
      unedited: true,
    });
    expect(log.join('\n')).toMatch(/updated the agent skill/);
  });

  test('leaves a hand-edited copy alone', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    installSkill({ cwd: root, version: '1.0.0' });
    fs.appendFileSync(skillInstallPath(root), 'HAND EDIT\n');
    const before = fs.readFileSync(skillInstallPath(root), 'utf8');
    await run();
    expect(fs.readFileSync(skillInstallPath(root), 'utf8')).toBe(before);
    expect(log).toEqual([]);
  });

  test('leaves a copy with no managed banner alone', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    fs.mkdirSync(path.dirname(skillInstallPath(root)), { recursive: true });
    fs.writeFileSync(skillInstallPath(root), '--- mine ---\n');
    await run();
    expect(fs.readFileSync(skillInstallPath(root), 'utf8')).toBe('--- mine ---\n');
  });

  test('installs a missing copy without touching an .agents copy of its own', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    const agents = path.join(root, '.agents', 'skills', 'stackctl', 'SKILL.md');
    fs.mkdirSync(path.dirname(agents), { recursive: true });
    fs.writeFileSync(agents, 'mine\n');
    fs.mkdirSync(path.join(root, '.cursor'));
    await run();
    expect(readInstalledSkill(skillInstallPath(root))?.version).toBe('1.2.3');
    expect(readInstalledSkill(path.join(root, '.cursor/skills/stackctl/SKILL.md'))?.version).toBe('1.2.3'); // oxfmt-ignore
    expect(fs.readFileSync(agents, 'utf8')).toBe('mine\n');
  });

  test('does nothing without INIT_CWD (not run by a package manager)', async () => {
    await run({});
    expect(fs.existsSync(skillInstallPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, 'stackctl.config.ts'))).toBe(false);
  });

  test('does nothing in CI', async () => {
    await run({ INIT_CWD: root, CI: 'true' });
    expect(fs.existsSync(skillInstallPath(root))).toBe(false);
  });

  test('counts CI=false as no CI, as the mode does', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    await run({ INIT_CWD: root, CI: 'false' });
    expect(readInstalledSkill(skillInstallPath(root))?.version).toBe('1.2.3');
  });

  test('does nothing when the installing project is not the one stackctl is installed in', async () => {
    // e.g. stackctl's own workspace, or an unrelated `INIT_CWD`: node_modules/stackctl there
    // does not resolve to this package.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-other-')));
    try {
      await run({ INIT_CWD: other });
      expect(fs.existsSync(skillInstallPath(other))).toBe(false);
      expect(fs.existsSync(path.join(other, 'stackctl.config.ts'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('never throws: a failure is reported and swallowed', async () => {
    fs.writeFileSync(path.join(root, 'stackctl.config.ts'), '');
    // `.claude` as a file makes the skill dir uncreatable.
    fs.writeFileSync(path.join(root, '.claude'), '');
    await expect(run()).resolves.toBeUndefined();
    expect(log.join('\n')).toMatch(/could not/i);
  });
});
