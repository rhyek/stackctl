/**
 * The Compose provider against a real Docker. Skipped when Docker isn't available, so the suite
 * still runs on a machine without it. Every test gets its own project name and directory, and
 * tears the project down afterwards whatever happened.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Config } from '../config.js';
import { ambientEnv, baseEnvs } from '../env.js';
import { execLines, streamLines } from '../spawn.js';
import { DockerComposeProvider } from './providers/docker-compose.js';
import type { ResolvedDockerComposeInfra } from './types.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// `init: true` and a short grace period so the `sleep` containers stop at once instead of
// sitting out Docker's ten-second SIGTERM timeout.
const COMPOSE_FILE = `
services:
  checked:
    image: alpine:3.20
    init: true
    stop_grace_period: 1s
    command: sh -c "sleep 1; touch /tmp/ready; sleep 600"
    volumes: [checked-data:/data]
    healthcheck:
      test: ['CMD', 'test', '-f', '/tmp/ready']
      interval: 1s
      retries: 60
  plain:
    image: alpine:3.20
    init: true
    stop_grace_period: 1s
    command: sleep 600
    volumes: [plain-data:/data]
  oneshot:
    image: alpine:3.20
    command: 'true'
volumes:
  checked-data:
  plain-data:
`;

let ws: string;
let counter = 0;
const projects: string[] = [];

/** A provider on a fresh project name; the project is removed after the test. */
function provider(
  services: ResolvedDockerComposeInfra['services'] = {},
  suffix = '',
): { provider: DockerComposeProvider; project: string } {
  const project = `stackctl-spec-${String(process.pid)}-${String(++counter)}${suffix}`;
  projects.push(project);
  return {
    project,
    provider: new DockerComposeProvider(
      { projectName: project, readyTimeout: 60_000, services },
      {
        workspaceDir: ws,
        profile: 'test',
        config: { profile: 'test' } as Config<string>,
        envs: baseEnvs(ws),
        tokens: {},
        exec: execLines,
        stream: streamLines,
        // Captured, not inherited: `down`'s output has no business in the test run's.
        spawnInherit: async (command, args, opts) =>
          (await execLines(command, args, opts)).exitCode,
        pollIntervalMs: 200,
      },
    ),
  };
}

async function docker(...args: string[]): Promise<string[]> {
  const { stdout } = await execLines('docker', args, { cwd: ws, env: ambientEnv() });
  return stdout.split('\n').filter(Boolean).sort();
}
const containers = (project: string) =>
  docker('ps', '--all', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Label "com.docker.compose.service"}}={{.State}}'); // oxfmt-ignore
const volumes = (project: string) =>
  docker('volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'); // oxfmt-ignore
const networks = (project: string) =>
  docker('network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'); // oxfmt-ignore

describe.skipIf(!dockerAvailable())(
  'DockerComposeProvider against real Docker',
  { timeout: 180_000 },
  () => {
    beforeEach(() => {
      ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-infra-docker-')));
      fs.writeFileSync(path.join(ws, 'compose.yaml'), COMPOSE_FILE);
    });

    afterEach(async () => {
      for (const project of projects.splice(0)) {
        await execLines(
          'docker',
          [
            'compose',
            '-p',
            project,
            '--project-directory',
            ws,
            'down',
            '--volumes',
            '--remove-orphans',
          ],
          { cwd: ws, env: ambientEnv() },
        );
      }
      fs.rmSync(ws, { recursive: true, force: true });
    });

    test('up waits for the healthcheck, accepts a one-shot service, and runs afterReady once ready', async () => {
      let sawReadyFile = false;
      const { provider: infra, project } = provider({
        checked: {
          enabled: true,
          afterReady: async ({ compose }) => {
            // Only true if afterReady really waited for the healthcheck to pass.
            await compose(['exec', '-T', 'checked', 'test', '-f', '/tmp/ready']);
            sawReadyFile = true;
          },
        },
      });
      const summary = await infra.up({});
      expect(summary).toEqual({
        ok: true,
        services: [
          { service: 'checked', ok: true },
          { service: 'oneshot', ok: true },
          { service: 'plain', ok: true },
        ],
      });
      expect(sawReadyFile).toBe(true);
      expect(await containers(project)).toEqual([
        'checked=running',
        'oneshot=exited',
        'plain=running',
      ]);

      // A second up, with everything already running, is quick and changes nothing.
      const startedAt = Date.now();
      expect((await infra.up({})).ok).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });

    test("a named destroy leaves a sibling's volume alone, even when the sibling has no container", async () => {
      const { provider: infra, project } = provider();
      await infra.up({});
      // The case `down <service> --volumes` gets wrong: a sibling whose container is gone.
      await execLines('docker', ['compose', '-p', project, '--project-directory', ws, 'rm', '--stop', '--force', 'plain'], { cwd: ws, env: ambientEnv() }); // oxfmt-ignore
      expect(await volumes(project)).toEqual([`${project}_checked-data`, `${project}_plain-data`]);

      expect((await infra.destroy({ services: ['checked'] })).ok).toBe(true);

      expect(await volumes(project)).toEqual([`${project}_plain-data`]);
      expect(await containers(project)).toEqual(['oneshot=exited']);
      expect(await networks(project)).toEqual([`${project}_default`]);
    });

    test('a full destroy removes the containers, the volumes and the network', async () => {
      const { provider: infra, project } = provider();
      await infra.up({});
      expect((await infra.destroy({})).ok).toBe(true);
      expect(await containers(project)).toEqual([]);
      expect(await volumes(project)).toEqual([]);
      expect(await networks(project)).toEqual([]);
    });

    test('a reset of one service gives it a fresh volume and keeps the others running', async () => {
      const { provider: infra, project } = provider();
      await infra.up({});
      const dc = (...args: string[]) =>
      execLines('docker', ['compose', '-p', project, '--project-directory', ws, ...args], { cwd: ws, env: ambientEnv() }); // oxfmt-ignore
      await dc('exec', '-T', 'checked', 'touch', '/data/marker');
      await dc('exec', '-T', 'plain', 'touch', '/data/marker');

      expect((await infra.up({ trigger: 'reset', services: ['checked'] })).ok).toBe(true);

      expect((await dc('exec', '-T', 'checked', 'test', '-f', '/data/marker')).exitCode).not.toBe(
        0,
      );
      expect((await dc('exec', '-T', 'plain', 'test', '-f', '/data/marker')).exitCode).toBe(0);
    });

    test('fresh is true only on the run that created the data', async () => {
      const seen: Record<string, boolean[]> = { checked: [], plain: [], oneshot: [] };
      const note = {
        enabled: true,
        afterReady: (ctx: { service: { name: string }; fresh: boolean }) => {
          seen[ctx.service.name]!.push(ctx.fresh);
        },
      };
      const { provider: infra } = provider({ checked: note, plain: note, oneshot: note });

      await infra.up({}); // 1: nothing existed
      await infra.up({}); // 2: everything is already there
      await infra.down([]);
      await infra.up({}); // 3: new containers, old volumes
      await infra.up({ trigger: 'reset', services: ['checked'] }); // 4: checked's volume was just removed

      expect(seen.checked).toEqual([true, false, false, true]);
      // `plain` has a named volume too, and was never reset.
      expect(seen.plain).toEqual([true, false, false]);
      // `oneshot` has no volume: it goes by its container, which `down` removed.
      expect(seen.oneshot).toEqual([true, false, true]);
    });

    test('down removes the containers and keeps the volumes', async () => {
      const { provider: infra, project } = provider();
      await infra.up({});
      expect(await infra.down([])).toBe(0);
      expect(await containers(project)).toEqual([]);
      expect(await volumes(project)).toEqual([`${project}_checked-data`, `${project}_plain-data`]);
    });

    test('two project names — two profiles — run side by side from the same compose file', async () => {
      const dev = provider({}, '-development');
      const testMode = provider({}, '-test');
      const [a, b] = await Promise.all([
        dev.provider.up({ services: ['plain'] }),
        testMode.provider.up({ services: ['plain'] }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(await containers(dev.project)).toEqual(['plain=running']);
      expect(await containers(testMode.project)).toEqual(['plain=running']);
    });

    test('a service that exits non-zero fails with its exit code and its logs', async () => {
      fs.writeFileSync(
        path.join(ws, 'compose.yaml'),
        'services:\n  broken:\n    image: alpine:3.20\n    command: sh -c "echo cannot open config; exit 3"\n',
      );
      const { provider: infra } = provider();
      const summary = await infra.up({});
      expect(summary.ok).toBe(false);
      expect(summary.services[0]!.error).toMatch(/^exited \(3\)\n[\s\S]*cannot open config/);
    });
  },
);
