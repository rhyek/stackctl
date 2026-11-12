import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  agentsFilePath,
  installRules,
  readAgentsBlock,
  readInstalledRules,
  refreshAgentsBlockIfStale,
  refreshRulesIfStale,
  renderAgentsBlock,
  renderRules,
  rulesInstallPath,
  writeAgentsBlock,
} from './agent-rules.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-agent-rules-'));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const asset = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '../assets', name), 'utf8');
const skill = () =>
  fs.readFileSync(path.join(import.meta.dirname, '../skills/stackctl/SKILL.md'), 'utf8');

describe('the always-on text', () => {
  test('is short, and points at the docs index without repeating it', () => {
    const text = asset('agent-rules.md');
    // read at the start of every session of every agent: a few lines, not a guide
    expect(text.length).toBeLessThan(700);
    expect(text).toContain('node_modules/stackctl/docs/llms.txt');
    expect(text).not.toContain('playbook');
  });

  test("names what the skill's description names, so both send the same tasks to the docs", () => {
    const description = /^description: (.*)$/m.exec(skill())![1]!;
    const rules = asset('agent-rules.md').replaceAll(/\s+/g, ' ');
    const scope = 'its dev services, their Docker Compose infrastructure (database, cache, mail catcher), `.env` loading, logs and test sessions'; // oxfmt-ignore
    expect(description).toContain(scope);
    expect(rules).toContain(scope);
  });
});

describe('the rules file', () => {
  test('opens with a banner carrying the version and a hash of the rest', () => {
    const [banner, ...rest] = renderRules('1.2.3').split('\n');
    expect(banner).toMatch(/^<!-- stackctl rules v1\.2\.3 sha256:[0-9a-f]{64} — managed by stackctl init; do not edit -->$/); // oxfmt-ignore
    expect(rest.join('\n')).toBe(asset('agent-rules.md').trim() + '\n');
  });

  test('installs to .claude/rules/stackctl.md, and says so about itself', () => {
    expect(installRules({ cwd, version: '1.2.3' })).toBe(rulesInstallPath(cwd));
    expect(rulesInstallPath(cwd)).toBe(path.join(cwd, '.claude/rules/stackctl.md'));
    expect(readInstalledRules(rulesInstallPath(cwd))).toEqual({ version: '1.2.3', unedited: true });
  });

  test('is refreshed when an older version wrote it and nobody edited it', () => {
    installRules({ cwd, version: '1.2.3' });
    expect(refreshRulesIfStale({ cwd, version: '1.2.3' })).toEqual([]);
    expect(refreshRulesIfStale({ cwd, version: '1.2.2' })).toEqual([]);
    expect(refreshRulesIfStale({ cwd, version: '1.3.0' })).toEqual([rulesInstallPath(cwd)]);
    expect(readInstalledRules(rulesInstallPath(cwd))).toEqual({ version: '1.3.0', unedited: true });
  });

  test('is left alone once hand-edited, or when it carries no banner', () => {
    installRules({ cwd, version: '1.2.3' });
    fs.appendFileSync(rulesInstallPath(cwd), 'a line of my own\n');
    expect(readInstalledRules(rulesInstallPath(cwd))).toEqual({
      version: '1.2.3',
      unedited: false,
    });
    expect(refreshRulesIfStale({ cwd, version: '2.0.0' })).toEqual([]);

    fs.writeFileSync(rulesInstallPath(cwd), '# mine\n');
    expect(readInstalledRules(rulesInstallPath(cwd))).toBeNull();
    expect(refreshRulesIfStale({ cwd, version: '2.0.0' })).toEqual([]);
    expect(fs.readFileSync(rulesInstallPath(cwd), 'utf8')).toBe('# mine\n');
  });
});

describe('the AGENTS.md block', () => {
  const read = () => fs.readFileSync(agentsFilePath(cwd), 'utf8');

  test('is the same text under a second-level heading, between two markers', () => {
    const block = renderAgentsBlock('1.2.3');
    expect(block.startsWith('<!-- BEGIN:stackctl v1.2.3 ')).toBe(true);
    expect(block.endsWith('<!-- END:stackctl -->\n')).toBe(true);
    expect(block).toContain('\n## stackctl\n');
    expect(block).toContain(
      asset('agent-rules.md')
        .trim()
        .replace(/^# stackctl\n/, ''),
    );
  });

  test('makes the file when there is none', () => {
    expect(readAgentsBlock(cwd)).toBeNull();
    expect(writeAgentsBlock({ cwd, version: '1.2.3' })).toBe('created');
    expect(read()).toBe(renderAgentsBlock('1.2.3'));
    expect(readAgentsBlock(cwd)).toEqual({ version: '1.2.3' });
  });

  test('goes at the end of a file that has none, a blank line after what is there', () => {
    for (const existing of ['# Mine\n\nA rule.\n', '# Mine\n\nA rule.', '# Mine\n\nA rule.\n\n']) {
      fs.writeFileSync(agentsFilePath(cwd), existing);
      expect(writeAgentsBlock({ cwd, version: '1.2.3' })).toBe('added');
      expect(read()).toBe(`# Mine\n\nA rule.\n\n${renderAgentsBlock('1.2.3')}`);
    }
  });

  test('replaces the block already there, and nothing outside it', () => {
    fs.writeFileSync(agentsFilePath(cwd), `# Mine\n\n${renderAgentsBlock('1.2.3')}\n## After\n\nKept.\n`); // oxfmt-ignore
    expect(writeAgentsBlock({ cwd, version: '1.3.0' })).toBe('updated');
    expect(read()).toBe(`# Mine\n\n${renderAgentsBlock('1.3.0')}\n## After\n\nKept.\n`);
    expect(read().match(/BEGIN:stackctl/g)).toHaveLength(1);
  });

  test('is refreshed only when an older version wrote it', () => {
    writeAgentsBlock({ cwd, version: '1.2.3' });
    expect(refreshAgentsBlockIfStale({ cwd, version: '1.2.3' })).toBe(false);
    expect(refreshAgentsBlockIfStale({ cwd, version: '1.2.0' })).toBe(false);
    expect(refreshAgentsBlockIfStale({ cwd, version: '1.3.0' })).toBe(true);
    expect(readAgentsBlock(cwd)).toEqual({ version: '1.3.0' });
  });

  test('is never added by a refresh', () => {
    fs.writeFileSync(agentsFilePath(cwd), '# Mine\n');
    expect(refreshAgentsBlockIfStale({ cwd, version: '9.0.0' })).toBe(false);
    expect(read()).toBe('# Mine\n');
    fs.rmSync(agentsFilePath(cwd));
    expect(refreshAgentsBlockIfStale({ cwd, version: '9.0.0' })).toBe(false);
    expect(fs.existsSync(agentsFilePath(cwd))).toBe(false);
  });
});
