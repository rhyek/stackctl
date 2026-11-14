import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AnyServiceConfig } from '../config.js';
import type { ControlClient, SessionStatus } from '../control-client.js';
import type { FoundSession } from '../find-session.js';
import { type WaitContext, runWaitCommand } from './wait.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-wait-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node .' } }));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = (name: string, over: Partial<AnyServiceConfig> = {}) =>
  ({ name, relativeDir: name, absoluteDir: dir, ...over }) as AnyServiceConfig;

const client = {} as ControlClient;

/** The profile's session as `findSession` reports it, with `services` its status's. */
function running(services: SessionStatus['services']): FoundSession {
  const status = { pid: 4242, profile: 'development', services, logFile: '/s/logs.txt' } as SessionStatus; // oxfmt-ignore
  return { kind: 'running', client, status, record: { port: 14001, pid: 4242 } };
}

const NONE: FoundSession = { kind: 'none' };
const HUNG: FoundSession = { kind: 'unresponsive', pid: 4242, port: 14001, reason: 'hung' };

/** A run whose `findSession` answers each of `answers` in turn, then the last one for good. */
function context(answers: FoundSession[], over: Partial<WaitContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const waited: { services: string[]; infra: boolean | undefined; deadline: number }[] = [];
  let asked = 0;
  const ctx: WaitContext = {
    root: dir,
    target: { profile: 'development', source: 'default' },
    services: [app('api'), app('web'), app('later', { autostart: false }), app('docs', { command: null })], // oxfmt-ignore
    find: async () => answers[Math.min(asked++, answers.length - 1)]!,
    wait: async (_client, services, opts) => {
      waited.push({ services: [...services], infra: opts.infra, deadline: opts.deadline });
      return undefined;
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    pollMs: 5,
    ...over,
  };
  return { ctx, out, err, waited, asked: () => asked };
}

describe('runWaitCommand', () => {
  test('a timeout must be a number of seconds above 0', async () => {
    const { ctx, err } = context([NONE]);
    expect(await runWaitCommand({ timeout: 0 }, ctx)).toBe(1);
    expect(err).toEqual(['--timeout takes a number of seconds above 0.']);
  });

  test("waits on the session's services that start, and the infra, then says where the session is", async () => {
    const services = { api: 'running', web: 'waiting', later: 'stopped', docs: 'stopped' } as const;
    const { ctx, out, waited } = context([running(services)]);
    const before = Date.now();
    expect(await runWaitCommand({ timeout: 60 }, ctx)).toBe(0);
    expect(waited).toEqual([{ services: ['api', 'web'], infra: true, deadline: expect.any(Number) }]); // oxfmt-ignore
    // One deadline for the whole wait.
    expect(waited[0]!.deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(waited[0]!.deadline).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(out).toEqual(['development session ready: pid 4242, control API on 14001, log /s/logs.txt']); // oxfmt-ignore
  });

  test('waits for the session to appear, answer and report its services', async () => {
    const { ctx, waited, asked } = context([NONE, NONE, HUNG, running(null), running({ api: 'waiting' })]); // oxfmt-ignore
    expect(await runWaitCommand({ timeout: 60 }, ctx)).toBe(0);
    expect(asked()).toBe(5);
    expect(waited.map((w) => w.services)).toEqual([['api']]);
  });

  test('with no session by the deadline, says none started', async () => {
    const { ctx, err, waited } = context([NONE]);
    expect(await runWaitCommand({ timeout: 0.05 }, ctx)).toBe(1);
    expect(err).toEqual(['stackctl: no development session started within 0.05s']);
    expect(waited).toEqual([]);
  });

  test("a session that still doesn't answer by the deadline is reported as such", async () => {
    const { ctx, err } = context([HUNG]);
    expect(await runWaitCommand({ timeout: 0.05 }, ctx)).toBe(1);
    expect(err).toEqual([
      "stackctl: a development session is recorded as running (pid 4242) but doesn't answer on its control API (port 14001): it looks hung",
    ]);
  });

  test('a session that ends before it reports its services fails the wait at once', async () => {
    const { ctx, err } = context([running(null), NONE]);
    expect(await runWaitCommand({ timeout: 60 }, ctx)).toBe(1);
    expect(err).toEqual(['stackctl: the development session ended while starting; see /s/logs.txt']); // oxfmt-ignore
  });

  test("the health wait's failure is the command's", async () => {
    const { ctx, err } = context([running({ api: 'waiting' })], {
      wait: async () => 'api stopped while starting; see /s/logs.txt',
    });
    expect(await runWaitCommand({ timeout: 60 }, ctx)).toBe(1);
    expect(err).toEqual(['stackctl: api stopped while starting; see /s/logs.txt']);
  });
});
