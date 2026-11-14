/**
 * The offer of the agent guidance: a person starting a session at a terminal is asked once, a
 * yes installs stackctl's own files and a no is remembered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Pty } from './pty.js';
import { fixtureWorkspace } from './suite.js';

const ws = fixtureWorkspace();

/** A person, whatever runs the suite: an agent's shell would never be asked. */
const person = { STACKCTL_STARTED_BY_AGENT: '0' };
const asked = 'Tell coding agents about stackctl in this repo?';
const declined = () => path.join(ws(), 'node_modules/.stackctl/agent-guidance.json');
const rules = () => path.join(ws(), '.claude/rules/stackctl.md');
const skill = () => path.join(ws(), '.claude/skills/stackctl/SKILL.md');

test('a no is remembered: the next start goes straight to the picker', async () => {
  fs.rmSync(declined());
  const first = await Pty.start({ cwd: ws(), env: person });
  await first.waitFor(asked);
  expect(first.text()).toContain('(a rules file and a skill under .claude/)');
  first.type('n');
  await first.waitFor('choose services');
  expect(fs.existsSync(path.join(ws(), '.claude'))).toBe(false);
  expect(fs.existsSync(declined())).toBe(true);
  await first.close();

  const second = await Pty.start({ cwd: ws(), env: person });
  await second.waitFor('choose services');
  expect(second.everShown(asked)).toBe(false);
});

test("a yes installs stackctl's own files, leaves AGENTS.md alone, and is not asked again", async () => {
  fs.rmSync(declined());
  const first = await Pty.start({ cwd: ws(), env: person });
  await first.waitFor(asked);
  first.press('enter');
  await first.waitFor('choose services');
  expect(fs.readFileSync(rules(), 'utf8')).toContain('node_modules/stackctl/docs/llms.txt');
  expect(fs.readFileSync(skill(), 'utf8')).toMatch(/^---\n# stackctl skill v/);
  expect(fs.existsSync(path.join(ws(), 'AGENTS.md'))).toBe(false);
  expect(fs.existsSync(declined())).toBe(false);
  await first.close();

  const second = await Pty.start({ cwd: ws(), env: person });
  await second.waitFor('choose services');
  expect(second.everShown(asked)).toBe(false);
});

test('an agent is never asked, and gets nothing installed', async () => {
  fs.rmSync(path.join(ws(), '.claude'), { recursive: true });
  // An agent names the profile, as it must.
  const pty = await Pty.start({ cwd: ws(), args: ['--profile', 'development'], env: { STACKCTL_STARTED_BY_AGENT: '1' } }); // oxfmt-ignore
  await pty.waitFor('choose services');
  expect(pty.everShown(asked)).toBe(false);
  expect(fs.existsSync(path.join(ws(), '.claude'))).toBe(false);
});
