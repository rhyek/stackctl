import { format } from 'node:util';
import { expect, test, vi } from 'vitest';
import { exitOnFatalError } from './errors.js';

/** Thrown by the `process.exit` mock, so the handler ends there as it would for real. */
const EXITED = new Error('process.exit called');

/** Runs the handler on `thrown`: what it printed on stderr, and every `process.exit` call. */
function fatal(thrown: unknown) {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw EXITED;
  });
  expect(() => exitOnFatalError(thrown)).toThrow(EXITED);
  return {
    stderr: error.mock.calls.map((args) => format(...args)).join('\n'),
    exits: exit.mock.calls,
  };
}

test('an error: printed on stderr as one line, `Error: <message>` with no stack, exit 1', () => {
  const err = new Error(
    'dev reverse proxy port 21050 is already in use by another program. Free it, or change `reverseProxy.port` in stackctl.config.ts.',
  );
  const { stderr, exits } = fatal(err);
  expect(stderr).toBe(`Error: ${err.message}`);
  expect(exits).toEqual([[1]]);
});

test('an error subclass: printed under its own name', () => {
  class ConfigLoadError extends Error {
    override name = 'ConfigLoadError';
  }
  const { stderr } = fatal(new ConfigLoadError('stackctl.config.ts has no default export'));
  expect(stderr).toBe('ConfigLoadError: stackctl.config.ts has no default export');
});

test('an error carrying a non-zero exitCode: exits with that code', () => {
  const err = Object.assign(new Error('`docker compose up` failed'), { exitCode: 3 });
  const { stderr, exits } = fatal(err);
  expect(stderr).toBe('Error: `docker compose up` failed');
  expect(exits).toEqual([[3]]);
});

test.each([0, 1.5, '2'])('an exitCode of %j is not one to exit with: exit 1', (exitCode) => {
  const { exits } = fatal(Object.assign(new Error('boom'), { exitCode }));
  expect(exits).toEqual([[1]]);
});

test("an errno `code` isn't an exit code: exit 1", () => {
  const err = Object.assign(new Error("EACCES: couldn't read .env"), { code: 'EACCES' });
  const { exits } = fatal(err);
  expect(exits).toEqual([[1]]);
});

test.each([
  ['a string', 'the session record is unreadable', 'the session record is unreadable'],
  ['null', null, 'null'],
])('a thrown value that is not an error (%s): printed as it is, exit 1', (_, thrown, printed) => {
  const { stderr, exits } = fatal(thrown);
  expect(stderr).toBe(printed);
  expect(exits).toEqual([[1]]);
});
