import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { composeMemory, containerMemory, socketPath } from './docker-engine.js';

describe('containerMemory', () => {
  test("docker stats' figure: usage less the inactive page cache, cgroup v2 and v1", () => {
    expect(containerMemory({ usage: 58404864, stats: { inactive_file: 536576 } })).toBe(57868288);
    expect(
      containerMemory({ usage: 1000, stats: { total_inactive_file: 300, inactive_file: 100 } }),
    ).toBe(700);
    expect(containerMemory({ usage: 1000, stats: { inactive_file: 2000 } })).toBe(1000);
    expect(containerMemory({})).toBe(0);
  });
});

describe('socketPath', () => {
  test('a unix endpoint only', () => {
    expect(socketPath('unix:///Users/me/.orbstack/run/docker.sock\n')).toBe(
      '/Users/me/.orbstack/run/docker.sock',
    );
    expect(socketPath('tcp://10.0.0.2:2376')).toBeNull();
    expect(socketPath('ssh://me@box')).toBeNull();
  });
});

describe('composeMemory', () => {
  let server: http.Server | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.close();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sums each Compose service's running containers, from the project's label", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-docker-'));
    const socket = path.join(dir, 'docker.sock');
    const seen: string[] = [];
    server = http.createServer((req, res) => {
      seen.push(decodeURIComponent(req.url ?? ''));
      const json = (body: unknown) => res.end(JSON.stringify(body));
      if (req.url?.startsWith('/containers/json')) {
        return json([
          { Id: 'a', Labels: { 'com.docker.compose.service': 'db' } },
          { Id: 'b', Labels: { 'com.docker.compose.service': 'worker' } },
          { Id: 'c', Labels: { 'com.docker.compose.service': 'worker' } },
          { Id: 'd', Labels: {} },
        ]);
      }
      const usage = { a: 100, b: 10, c: 20 }[req.url!.split('/')[2] as 'a' | 'b' | 'c'];
      return json({ memory_stats: { usage, stats: { inactive_file: 0 } } });
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));

    const out = await composeMemory(socket, 'shop-development');
    expect(out).toEqual(
      new Map([
        ['db', 100],
        ['worker', 30],
      ]),
    );
    expect(seen[0]).toContain('"label":["com.docker.compose.project=shop-development"]');
    expect(seen.filter((u) => u.includes('one-shot=true'))).toHaveLength(3);
  });
});
