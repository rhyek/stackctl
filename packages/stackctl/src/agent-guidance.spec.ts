import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const answer = vi.hoisted(() => ({ next: true as unknown, asked: [] as string[] }));
vi.mock('@clack/prompts', () => ({
  confirm: (opts: { message: string }) => {
    answer.asked.push(opts.message);
    return Promise.resolve(answer.next);
  },
  isCancel: (value: unknown) => value === 'cancelled',
  log: { step: () => undefined },
}));

import {
  guidanceAtStart,
  guidanceState,
  hasDeclined,
  installGuidance,
  linkedSkill,
  offerGuidance,
  refreshGuidance,
} from './agent-guidance.js';
import {
  installRules,
  readAgentsBlock,
  readInstalledRules,
  rulesInstallPath,
} from './agent-rules.js';
import { installSkill, readInstalledSkill, skillInstallPath } from './skill.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-agent-guidance-')));
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  answer.next = true;
  answer.asked = [];
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

/** stackctl installed with a `skills/` folder, and that skill linked as `pnpm approve` links it. */
function linkSkill(name = 'pnpm-stackctl-stackctl'): string {
  const shipped = path.join(cwd, 'node_modules/stackctl/skills/stackctl');
  fs.mkdirSync(shipped, { recursive: true });
  fs.writeFileSync(path.join(shipped, 'SKILL.md'), '---\nname: stackctl\n---\n');
  fs.mkdirSync(path.join(cwd, '.claude/skills'), { recursive: true });
  const link = path.join(cwd, '.claude/skills', name);
  fs.symlinkSync(shipped, link);
  return link;
}

describe('guidanceState', () => {
  test('says what is there', () => {
    expect(guidanceState(cwd)).toEqual({ skill: 'missing', rules: false, block: false });
    installGuidance({ cwd, version: '1.2.3', own: true, agentsMd: true });
    expect(guidanceState(cwd)).toEqual({ skill: 'installed', rules: true, block: true });
  });

  test('knows a skill linked out of the installed package from one of its own', () => {
    expect(linkedSkill(cwd)).toBeNull();
    const link = linkSkill();
    expect(linkedSkill(cwd)).toBe(link);
    expect(guidanceState(cwd).skill).toBe('linked');
  });

  test('a link to anything else is no linked skill', () => {
    fs.mkdirSync(path.join(cwd, 'node_modules/stackctl'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'elsewhere'));
    fs.mkdirSync(path.join(cwd, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(cwd, 'elsewhere'), path.join(cwd, '.claude/skills/other'));
    expect(linkedSkill(cwd)).toBeNull();
  });
});

describe('installGuidance', () => {
  test("writes stackctl's own files and leaves AGENTS.md alone, unless asked for it", () => {
    expect(installGuidance({ cwd, version: '1.2.3', own: true, agentsMd: false })).toEqual([
      'Installed agent skill and rules file',
    ]);
    expect(readInstalledSkill(skillInstallPath(cwd))?.version).toBe('1.2.3');
    expect(readInstalledRules(rulesInstallPath(cwd))?.version).toBe('1.2.3');
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(false);

    expect(installGuidance({ cwd, version: '1.2.3', own: true, agentsMd: true })).toEqual([
      'Updated agent skill and rules file',
      'Created AGENTS.md',
    ]);
    expect(readAgentsBlock(cwd)).toEqual({ version: '1.2.3' });
  });

  test('writes no skill of its own beside a linked one, even under the same name', () => {
    linkSkill('stackctl');
    const shipped = fs.readFileSync(path.join(cwd, 'node_modules/stackctl/skills/stackctl/SKILL.md'), 'utf8'); // oxfmt-ignore
    expect(installGuidance({ cwd, version: '1.2.3', own: true, agentsMd: false })).toEqual([
      'Installed agent rules file',
    ]);
    // nothing written through the link, into node_modules
    expect(fs.readFileSync(path.join(cwd, 'node_modules/stackctl/skills/stackctl/SKILL.md'), 'utf8')).toBe(shipped); // oxfmt-ignore
    expect(fs.existsSync(rulesInstallPath(cwd))).toBe(true);
  });
});

describe('refreshGuidance', () => {
  test('brings what an older version wrote up to date, and installs nothing', () => {
    expect(refreshGuidance({ cwd, version: '2.0.0' })).toEqual([]);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);

    installGuidance({ cwd, version: '1.0.0', own: true, agentsMd: true });
    expect(refreshGuidance({ cwd, version: '2.0.0' })).toEqual([
      skillInstallPath(cwd),
      rulesInstallPath(cwd),
      path.join(cwd, 'AGENTS.md'),
    ]);
    expect(readInstalledSkill(skillInstallPath(cwd))?.version).toBe('2.0.0');
    expect(readAgentsBlock(cwd)).toEqual({ version: '2.0.0' });
  });

  test("removes stackctl's own copy of the skill once one is linked, unless it was edited", () => {
    installSkill({ cwd, version: '1.2.3' });
    linkSkill();
    expect(refreshGuidance({ cwd, version: '1.2.3' })).toEqual([skillInstallPath(cwd)]);
    expect(fs.existsSync(path.dirname(skillInstallPath(cwd)))).toBe(false);

    installSkill({ cwd, version: '1.2.3' });
    fs.appendFileSync(skillInstallPath(cwd), 'a line of my own\n');
    expect(refreshGuidance({ cwd, version: '1.2.3' })).toEqual([]);
    expect(fs.existsSync(skillInstallPath(cwd))).toBe(true);
  });
});

describe('offerGuidance', () => {
  test("asks one question, and a yes installs stackctl's own files and no AGENTS.md section", async () => {
    expect(await offerGuidance({ cwd, version: '1.2.3' })).toEqual([
      'Installed agent skill and rules file',
    ]);
    expect(answer.asked).toEqual([
      'Tell coding agents about stackctl in this repo? (a rules file and a skill under .claude/)',
    ]);
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(false);
    expect(hasDeclined(cwd)).toBe(false);
  });

  test('offers only the rules file where the skill is linked', async () => {
    linkSkill();
    expect(await offerGuidance({ cwd, version: '1.2.3' })).toEqual(['Installed agent rules file']);
    expect(answer.asked[0]).toContain('(a rules file under .claude/)');
  });

  test('remembers a no, answered or cancelled', async () => {
    answer.next = false;
    expect(await offerGuidance({ cwd, version: '1.2.3' })).toBeNull();
    expect(hasDeclined(cwd)).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);

    fs.rmSync(path.join(cwd, 'node_modules/.stackctl'), { recursive: true });
    answer.next = 'cancelled';
    expect(await offerGuidance({ cwd, version: '1.2.3' })).toBeNull();
    expect(hasDeclined(cwd)).toBe(true);
  });
});

describe('guidanceAtStart', () => {
  test('asks a person at a terminal once, while one of the own files is missing', async () => {
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: true });
    expect(answer.asked).toHaveLength(1);
    expect(fs.existsSync(rulesInstallPath(cwd))).toBe(true);

    await guidanceAtStart({ cwd, version: '1.2.3', interactive: true });
    expect(answer.asked).toHaveLength(1);
  });

  test('asks someone who has the skill but not the rules file, as after an upgrade', async () => {
    installSkill({ cwd, version: '1.0.0' });
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: true });
    expect(answer.asked).toHaveLength(1);
    expect(readInstalledRules(rulesInstallPath(cwd))?.version).toBe('1.2.3');
  });

  test('never asks again after a no', async () => {
    answer.next = false;
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: true });
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: true });
    expect(answer.asked).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  test('never asks an agent, a script or CI, and installs nothing for them', async () => {
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: false });
    expect(answer.asked).toHaveLength(0);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  test('keeps what is installed current, asked or not', async () => {
    installRules({ cwd, version: '1.0.0' });
    installSkill({ cwd, version: '1.0.0' });
    await guidanceAtStart({ cwd, version: '1.2.3', interactive: false });
    expect(readInstalledRules(rulesInstallPath(cwd))?.version).toBe('1.2.3');
    expect(readInstalledSkill(skillInstallPath(cwd))?.version).toBe('1.2.3');
    expect(answer.asked).toHaveLength(0);
  });
});
