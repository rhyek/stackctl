import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { startedByAgent } from '../agent-detection';
import { maskSecrets } from '../event-log';
import { runCli, sdkCallerBy, streamCli } from './cli-child';

/**
 * The SDK's child-CLI helpers against stub scripts that stand in for the CLI: each writes (or
 * doesn't) a result to descriptor 3, prints, and exits as the case needs.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-child-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function stub(body: string): string {
  const file = path.join(dir, `stub-${String(++n)}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs';\n${body}\n`);
  return file;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runCli', () => {
  test('a written result resolves, even with exit 1', async () => {
    const file = stub(`fs.writeSync(3, JSON.stringify({ ok: false })); process.exit(1);`);
    await expect(runCli([file])).resolves.toEqual({ ok: false });
  });

  test("no result and exit 1 rejects with the child's stderr, without its colors", async () => {
    const file = stub(`console.error('\\x1b[31mno such service: nope\\x1b[39m'); process.exit(1);`);
    await expect(runCli([file])).rejects.toThrow(/^no such service: nope$/);
  });

  test('no result and exit 0 rejects', async () => {
    const file = stub(`process.exit(0);`);
    await expect(runCli([file])).rejects.toThrow('stackctl wrote no result');
  });

  test('the by it is handed reaches the child as STACKCTL_EVENT_BY', async () => {
    const file = stub(`fs.writeSync(3, JSON.stringify(process.env.STACKCTL_EVENT_BY ?? null));`);
    const by = { kind: 'sdk', script: 'x.ts' } as never;
    await expect(runCli([file], { by })).resolves.toBe(JSON.stringify(by));
  });
});

describe('sdkCallerBy', () => {
  test("is this process's script, arguments and directory, as absolute paths", async () => {
    expect(await sdkCallerBy()).toEqual({
      kind: 'sdk',
      argv: maskSecrets(process.argv.slice(1)),
      cwd: process.cwd(),
      agent: startedByAgent(),
    });
  });
});

describe('streamCli', () => {
  test('yields every line until the child exits', async () => {
    const file = stub(`console.log('a'); console.log('b'); console.log('c');`);
    const lines: string[] = [];
    for await (const line of streamCli([file])) {
      lines.push(line);
    }
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  test('a child that fails throws its stderr, colors stripped', async () => {
    const file = stub(
      `console.log('a'); console.error('\\x1b[31mno session has run here yet\\x1b[39m'); process.exit(1);`,
    );
    const lines: string[] = [];
    await expect(
      (async () => {
        for await (const line of streamCli([file])) {
          lines.push(line);
        }
      })(),
    ).rejects.toThrow(/^no session has run here yet$/);
    expect(lines).toEqual(['a']);
  });

  test('ends its child when the loop breaks', async () => {
    const file = stub(`console.log(process.pid); setInterval(() => console.log('tick'), 50);`);
    let pid = 0;
    for await (const line of streamCli([file])) {
      pid = Number(line);
      break;
    }
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(alive(pid)).toBe(false);
  });

  test('ends its child when the signal aborts', async () => {
    const file = stub(`console.log(process.pid); setInterval(() => console.log('tick'), 50);`);
    const controller = new AbortController();
    let pid = 0;
    const lines: string[] = [];
    for await (const line of streamCli([file], controller.signal)) {
      if (pid === 0) {
        pid = Number(line);
        controller.abort();
      } else {
        lines.push(line);
      }
    }
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(alive(pid)).toBe(false);
  });
});
