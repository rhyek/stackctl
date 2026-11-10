import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  renderSkill,
  contentHash,
  installSkill,
  refreshSkillIfStale,
  isSkillInstalled,
  readInstalledSkill,
  skillInstallPath,
} from './skill.js';

describe('skill rendering', () => {
  test('embeds the managed banner with the version', () => {
    const out = renderSkill('1.2.3');
    expect(out).toContain('stackctl skill v1.2.3');
    expect(out).toContain('do not edit');
  });

  // The regression that made this skill undiscoverable in every repo it was installed into.
  //
  // YAML frontmatter has to start on line 1. The banner used to be an HTML comment ABOVE it, so
  // the block was never parsed as frontmatter — and the agent saw the banner where `description`
  // should be. That field is the entire basis on which a skill is invoked, so the effect was a
  // skill that could not trigger, in a way nothing surfaces as an error.
  test('opens with frontmatter on line 1, with the banner INSIDE it', () => {
    const lines = renderSkill('1.2.3').split('\n');

    expect(lines[0]).toBe('---');
    expect(lines[1]).toContain('stackctl skill v1.2.3');
    expect(lines[1]!.startsWith('#')).toBe(true);

    // …and the fields a loader needs are still where it expects them.
    const close = lines.indexOf('---', 1);
    const frontmatter = lines.slice(1, close);
    expect(frontmatter.some((l) => l.startsWith('name:'))).toBe(true);
    expect(frontmatter.some((l) => l.startsWith('description:'))).toBe(true);
  });

  test('re-rendering an already-managed file does not stack banners', () => {
    // `refreshSkillIfStale` re-renders in place on every version bump.
    const once = renderSkill('1.2.3');
    const twice = renderSkill('1.2.4');
    expect(once.match(/do not edit/g)).toHaveLength(1);
    expect(twice.match(/do not edit/g)).toHaveLength(1);
    expect(twice).not.toContain('v1.2.3');
  });

  test('the banner carries version and hash', () => {
    const out = renderSkill('1.0.0');
    const lines = out.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toMatch(
      /^# stackctl skill v1\.0\.0 sha256:[0-9a-f]{64} — managed by stackctl init; do not edit$/,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-skill-'));
    try {
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, out);
      expect(readInstalledSkill(file)).toEqual({ version: '1.0.0', unedited: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contentHash is stable and differs by input', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('skill install + refresh', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-skill-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('installs then refreshes on version bump but preserves hand-edits', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/stackctl/SKILL.md');
    expect(fs.existsSync(file)).toBe(true);

    // Unedited → bump rewrites to new version.
    refreshSkillIfStale({ cwd, version: '1.1.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('v1.1.0');

    // Hand-edit → next bump leaves it untouched.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nHAND EDIT\n');
    refreshSkillIfStale({ cwd, version: '1.2.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('HAND EDIT');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('v1.2.0');
  });

  test('does not refresh when the recorded version is not older', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/stackctl/SKILL.md');
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('v1.0.0');
  });

  test('installs to .agents and .cursor when those dirs already exist', () => {
    fs.mkdirSync(path.join(cwd, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    installSkill({ cwd, version: '1.0.0' });
    expect(fs.existsSync(path.join(cwd, '.agents/skills/stackctl/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.cursor/skills/stackctl/SKILL.md'))).toBe(true);
  });

  test('writes no skill.json', () => {
    installSkill({ cwd, version: '1.0.0' });
    expect(fs.existsSync(path.join(cwd, 'node_modules/.stackctl/skill.json'))).toBe(false);
  });

  test('refreshes an unedited older skill', () => {
    installSkill({ cwd, version: '0.9.0' });
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    const text = fs.readFileSync(skillInstallPath(cwd), 'utf8');
    expect(text.split('\n')[1]).toContain('stackctl skill v1.0.0 ');
    expect(readInstalledSkill(skillInstallPath(cwd))).toEqual({ version: '1.0.0', unedited: true });
  });

  test('leaves a hand-edited skill alone', () => {
    installSkill({ cwd, version: '0.9.0' });
    const file = skillInstallPath(cwd);
    fs.appendFileSync(file, 'HAND EDIT\n');
    const before = fs.readFileSync(file, 'utf8');
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('leaves a file without a managed banner alone', () => {
    const file = skillInstallPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const plain = '---\nname: stackctl\n---\nmine\n';
    fs.writeFileSync(file, plain);
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).toBe(plain);

    // The previous banner has no hash, so it does not count as managed either.
    const old =
      '---\n# stackctl skill v0.9.0 — managed by `stackctl init`; do not edit\nname: stackctl\n---\nx\n';
    fs.writeFileSync(file, old);
    expect(readInstalledSkill(file)).toBeNull();
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
  });

  test('refreshes the .agents and .cursor copies', () => {
    fs.mkdirSync(path.join(cwd, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    installSkill({ cwd, version: '0.9.0' });
    const agents = path.join(cwd, '.agents/skills/stackctl/SKILL.md');
    const cursor = path.join(cwd, '.cursor/skills/stackctl/SKILL.md');
    fs.appendFileSync(cursor, 'HAND EDIT\n');
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(readInstalledSkill(skillInstallPath(cwd))?.version).toBe('1.0.0');
    expect(readInstalledSkill(agents)?.version).toBe('1.0.0');
    // An edited copy is left alone while the others refresh.
    expect(fs.readFileSync(cursor, 'utf8')).toContain('HAND EDIT');
    expect(readInstalledSkill(cursor)).toEqual({ version: '0.9.0', unedited: false });
  });

  test('is a no-op when the skill was never installed', () => {
    expect(() => refreshSkillIfStale({ cwd, version: '9.9.9' })).not.toThrow();
  });
});

describe('isSkillInstalled', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-skill-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('isSkillInstalled reflects whether the canonical skill file exists', () => {
    expect(isSkillInstalled(cwd)).toBe(false);
    installSkill({ cwd, version: '1.0.0' });
    expect(isSkillInstalled(cwd)).toBe(true);
  });
});
