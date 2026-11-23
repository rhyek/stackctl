import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { EventBy } from '../event-log';
import { sessionsDir } from '../session-files';
import { oneOffRecorder } from './record';

let root: string;
const by: EventBy = { kind: 'cli', argv: ['exec'], cwd: '.', agent: false };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-record-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every line of the profile's event logs, parsed, in the order written. */
function lines(): Record<string, unknown>[] {
  const dir = sessionsDir(root, 'test');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .flatMap((id) => fs.readFileSync(path.join(dir, id, 'events.jsonl'), 'utf8').split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('oneOffRecorder', () => {
  test('exec: a begin and an end line where it ran, the command masked', () => {
    const ask = {
      kind: 'exec' as const,
      command: ['psql', 'postgres://app:secret@db/app'] as [string, ...string[]],
    };
    const record = oneOffRecorder(ask, { root, profile: 'test', nested: false, by });
    record({ service: 'api' }).end({ ok: false, exitCode: 2, signal: null });
    const [begin, end] = lines();
    // The fields in the order every one-off command's line has them; the log's own follow.
    expect(Object.keys(begin!).slice(0, 7)).toEqual([
      'type',
      'phase',
      'id',
      'kind',
      'service',
      'command',
      'by',
    ]);
    expect(begin).toMatchObject({
      type: 'one-off-command',
      phase: 'begin',
      kind: 'exec',
      service: 'api',
      command: ['psql', 'postgres://app:***@db/app'],
      by,
    });
    expect(end).toMatchObject({ phase: 'end', id: begin!.id, ok: false, exitCode: 2 });
  });

  test('run: the script and its arguments masked, one entry per place', () => {
    const ask = { kind: 'run' as const, script: 'migrate', args: ['postgres://u:p@db/x'] };
    const record = oneOffRecorder(ask, { root, profile: 'test', nested: false, by });
    record({ service: 'api' });
    record({ dir: 'tools' });
    expect(lines()).toEqual([
      expect.objectContaining({
        service: 'api',
        script: 'migrate',
        args: ['postgres://u:***@db/x'],
      }),
      expect.objectContaining({ dir: 'tools', script: 'migrate', args: ['postgres://u:***@db/x'] }),
    ]);
  });

  test('nested: nothing is written', () => {
    const ask = { kind: 'run' as const, script: 'test', args: [] };
    const record = oneOffRecorder(ask, { root, profile: 'test', nested: true, by });
    record({ service: 'api' }).end({ ok: true, exitCode: 0, signal: null });
    expect(lines()).toEqual([]);
  });
});
