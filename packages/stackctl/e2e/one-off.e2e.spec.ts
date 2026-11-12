/**
 * `stackctl exec` hands the terminal to the command: on a terminal the command sees one, and
 * without one (or for a coding agent) its output is piped and logged, as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runCli } from './processes.js';
import { Pty } from './pty.js';
import { fixtureWorkspace } from './suite.js';

const ws = fixtureWorkspace();

/** A command printing whether its stdout and stderr are terminals, tagged so its log is found. */
const probe = (tag: string) => [
  'exec',
  '--',
  'node',
  '-e',
  `console.log('${tag}', String(process.stdout.isTTY), String(process.stderr.isTTY))`,
];

/** The lines of the one-off log whose first line names `tag`, without their timestamps. */
function logOf(tag: string): string[] {
  const sessions = path.join(ws(), 'node_modules', '.stackctl', 'modes', 'development', 'sessions');
  for (const session of fs.readdirSync(sessions)) {
    const dir = path.join(sessions, session, 'commands');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n');
      if (lines[0]?.includes(tag)) {
        return lines.map((line) => line.replace(/^\S+ \S+ /, ''));
      }
    }
  }
  throw new Error(`no one-off log names ${tag}`);
}

test('on a terminal, the command gets the terminal; the log records the run', async () => {
  const pty = await Pty.start({ cwd: ws(), args: probe('on-a-tty') });
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(pty.text()).toContain('on-a-tty true true');
  const log = logOf('on-a-tty');
  expect(log.slice(1)).toEqual([
    'stdout and stderr went to the terminal, not to this log',
    expect.stringMatching(/^✔ finished in /),
  ]);
});

test('without a terminal, the output is piped and logged', async () => {
  const proc = await runCli(probe('no-tty'), { cwd: ws() });
  expect(await proc.waitForExit()).toEqual({ code: 0, signal: null });
  expect(proc.stdout).toBe('no-tty undefined undefined\n');
  expect(logOf('no-tty').slice(1)).toEqual([
    'no-tty undefined undefined',
    expect.stringMatching(/^✔ finished in /),
  ]);
});

test('a coding agent on a terminal still gets pipes, and its log holds the output', async () => {
  const pty = await Pty.start({
    cwd: ws(),
    // An agent names the mode.
    args: ['--mode', 'development', ...probe('agent-tty')],
    env: { STACKCTL_STARTED_BY_AGENT: '1' },
  });
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(pty.text()).toContain('agent-tty undefined undefined');
  expect(logOf('agent-tty')[1]).toBe('agent-tty undefined undefined');
});
