/**
 * The run screen: footer clicks and the commands menu, the log filter, and quitting with Ctrl+C.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { WEB_SCRIPT } from './fixture.js';
import type { Pty } from './pty.js';
import {
  allRunning,
  expectTerminalRestored,
  fixtureWorkspace,
  startEveryService,
} from './suite.js';

const ws = fixtureWorkspace();

/** The log pane: every row above the footer's rule line. */
function logRows(pty: Pty): string[] {
  const lines = pty.lines();
  const rule = lines.findLastIndex((line) => line.startsWith('── '));
  return lines.slice(0, rule);
}

test('a click on a service focuses it; m commands, then a script row, runs the script', async () => {
  const pty = await startEveryService(ws());
  expect(pty.focusedService()).toBe('api');

  pty.clickText('● web');
  await pty.waitUntil(() => pty.focusedService() === 'web', 'web focused');
  expect(allRunning(pty)).toBe(true);

  pty.clickText('m commands');
  await pty.waitFor('web · run');
  expect(pty.text()).toContain(WEB_SCRIPT);
  expect(pty.text()).toContain('custom command…');

  pty.clickText(WEB_SCRIPT, 1);
  await pty.waitFor(`✔ ${WEB_SCRIPT} finished`);
  expect(pty.text()).not.toContain('web · run');
  const log = logRows(pty).join('\n');
  expect(log).toMatch(new RegExp(`\\[web\\s*\\] ▶ running: ${WEB_SCRIPT}`));
  expect(log).toMatch(/\[web\s*\] hello from the web menu/);
  expect(log.indexOf(`▶ running: ${WEB_SCRIPT}`)).toBeLessThan(
    log.indexOf(`✔ ${WEB_SCRIPT} finished`),
  );
});

test('the filter: f, terms, ⏎ applies them to the log; esc clears it', async () => {
  const pty = await startEveryService(ws());
  expect(logRows(pty).join('\n')).toMatch(/\[worker\s*\] worker listening/);

  pty.press('f');
  await pty.waitFor('filter ›');
  pty.type('web');
  await pty.waitFor('filter › web');
  pty.press('enter');
  await pty.waitFor('f filter: web');
  await pty.waitUntil(
    () => !logRows(pty).some((row) => row.includes('[worker')),
    'the log filtered to web',
  );
  const filtered = logRows(pty).filter((row) => row.trim() !== '');
  expect(filtered.length).toBeGreaterThan(0);
  expect(
    filtered.every((row) => row.includes('web')),
    filtered.join('\n'),
  ).toBe(true);
  expect(filtered.join('\n')).toMatch(/\[web\s*\] web listening on 21082/);

  pty.press('esc');
  await pty.waitUntil(
    () => logRows(pty).some((row) => /\[worker\s*\] worker listening/.test(row)),
    'every line back',
  );
  expect(pty.text()).not.toContain('f filter: web');
});

test('the rule line follows a switch of the git branch, and every service keeps running', async () => {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', ...args], {
      cwd: ws(),
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  git('init', '-q', '-b', 'main');
  try {
    git('commit', '-q', '--allow-empty', '-m', 'first');
    const pty = await startEveryService(ws());
    const rule = () => pty.lines().findLast((line) => line.startsWith('── ')) ?? '';
    await pty.waitUntil(() => rule().includes('⎇ main'), 'the branch on the rule line');
    git('switch', '-q', '-c', 'feature');
    await pty.waitUntil(() => rule().includes('⎇ feature'), 'the new branch on the rule line');
    expect(allRunning(pty)).toBe(true);
  } finally {
    fs.rmSync(path.join(ws(), '.git'), { recursive: true, force: true });
  }
});

test('Ctrl+C once asks for a second; twice quits with exit 0 and gives the terminal back', async () => {
  const pty = await startEveryService(ws());

  pty.press('ctrl-c');
  await pty.waitFor('Press Ctrl+C again to exit');
  // Once is not a quit: the toast goes, and the session runs on.
  await pty.waitUntil(
    () => !pty.text().includes('Press Ctrl+C again to exit'),
    'the toast to go',
    10_000,
  );
  expect(pty.exit).toBeNull();
  expect(pty.text()).toContain('r restart');

  pty.press('ctrl-c');
  await pty.waitFor('Press Ctrl+C again to exit');
  pty.press('ctrl-c');
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  const printed = expectTerminalRestored(pty);
  expect(printed).toContain('■ stackctl exited after');
  expect(printed).toMatch(/logfile: node_modules\/\.stackctl\/modes\/development\/logs\/\S+\.log/);
});

test("writes the keys to the event log: r's restart and Ctrl+C's quit, each with the key that asked", async () => {
  // oxfmt-ignore
  const pty = await startEveryService(ws());
  expect(pty.focusedService()).toBe('api');
  pty.press('r');
  await pty.waitUntil(() => logRows(pty).some((row) => /\[api\s*\] restarted/.test(row)), 'api restarted'); // oxfmt-ignore
  pty.press('ctrl-c');
  await pty.waitFor('Press Ctrl+C again to exit');
  pty.press('ctrl-c');
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });

  const all = fs
    .readFileSync(path.join(ws(), 'node_modules/.stackctl/modes/development/events.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; phase?: string; by?: unknown });
  // The file's other sessions are this file's earlier tests': this one's start from its own.
  const lines = all.slice(all.findLastIndex((line) => line.type === 'session-start'));
  const commands = lines.filter((line) => line.type.endsWith('-command'));
  expect(commands).toMatchObject([
    { type: 'service-command', phase: 'begin', action: 'restart', service: 'api', by: { kind: 'ui', key: 'r' } }, // oxfmt-ignore
    { type: 'service-command', phase: 'end', action: 'restart', service: 'api', ok: true, outcome: 'done' }, // oxfmt-ignore
    { type: 'session-command', phase: 'begin', action: 'quit', by: { kind: 'ui', key: '^c' } },
    { type: 'session-command', phase: 'end', action: 'quit', ok: true },
  ]);
  expect(lines.at(-1)).toMatchObject({ type: 'session-end', cause: 'quit' });
  expect(lines[0]).toMatchObject({ type: 'session-start', headless: false });
});
