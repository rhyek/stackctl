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
import type { Config } from '../config';
import { ambientEnv, baseEnvs } from '../env';
import { execLines, streamLines } from '../spawn';
import { DockerComposeProvider } from './providers/docker-compose';
import type { ResolvedDockerComposeInfra } from './types';

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

/** `docker <args>` by hand, in the workspace, not through the provider. */
const dockerExec = (...args: string[]) => execLines('docker', args, { cwd: ws, env: ambientEnv() });
/** `docker compose <args>` by hand, on `project`. */
const dockerCompose = (project: string, ...args: string[]) =>
  dockerExec('compose', '-p', project, '--project-directory', ws, ...args);

/** What `docker <args>` prints, a sorted line each. */
async function docker(...args: string[]): Promise<string[]> {
  const { stdout } = await dockerExec(...args);
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
        await dockerCompose(project, 'down', '--volumes', '--remove-orphans');
      }
      fs.rmSync(ws, { recursive: true, force: true });
    });

    test('up waits for the healthcheck, accepts a one-shot service, and runs afterReady once ready', async () => {
      let sawReadyFile = false;
      const { provider: infra, project } = provider({
        checked: {
          enabled: true,
          tags: [],
          lifecycle: {
            afterReady: async ({ compose }) => {
              // Only true if afterReady really waited for the healthcheck to pass.
              await compose(['exec', '-T', 'checked', 'test', '-f', '/tmp/ready']);
              sawReadyFile = true;
            },
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
      await dockerCompose(project, 'rm', '--stop', '--force', 'plain');
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
      await dockerCompose(project, 'exec', '-T', 'checked', 'touch', '/data/marker');
      await dockerCompose(project, 'exec', '-T', 'plain', 'touch', '/data/marker');

      expect((await infra.up({ trigger: 'reset', services: ['checked'] })).ok).toBe(true);

      expect(
        (await dockerCompose(project, 'exec', '-T', 'checked', 'test', '-f', '/data/marker'))
          .exitCode,
      ).not.toBe(0);
      expect(
        (await dockerCompose(project, 'exec', '-T', 'plain', 'test', '-f', '/data/marker'))
          .exitCode,
      ).toBe(0);
    });

    /** afterReady callbacks that record each service's `fresh`, by name. */
    function freshRecorder() {
      const seen: Record<string, boolean[]> = {};
      const note = {
        enabled: true,
        tags: [],
        lifecycle: {
          afterReady: (ctx: { service: { name: string }; fresh: boolean }) => {
            (seen[ctx.service.name] ??= []).push(ctx.fresh);
          },
        },
      };
      return { seen, note };
    }

    test('fresh is true only on the run that created the data', async () => {
      const { seen, note } = freshRecorder();
      const { provider: infra } = provider({ checked: note, plain: note, oneshot: note });

      await infra.up({}); // 1: nothing existed
      await infra.up({}); // 2: everything is already there
      await infra.down({});
      await infra.up({}); // 3: new containers, old volumes
      await infra.up({ trigger: 'reset', services: ['checked'] }); // 4: checked's volume was just removed

      expect(seen.checked).toEqual([true, false, false, true]);
      // `plain` has a named volume too, and was never reset.
      expect(seen.plain).toEqual([true, false, false]);
      // `oneshot` has no volume: it goes by its container, which `down` removed.
      expect(seen.oneshot).toEqual([true, false, true]);
    });

    test('a reset of a project that was never created starts it, fresh', async () => {
      const { seen, note } = freshRecorder();
      const { provider: infra, project } = provider({ checked: note, plain: note, oneshot: note });
      expect((await infra.up({ trigger: 'reset' })).ok).toBe(true);
      expect(seen).toEqual({ checked: [true], plain: [true], oneshot: [true] });
      expect(await volumes(project)).toEqual([`${project}_checked-data`, `${project}_plain-data`]);
    });

    test('a reset of one service of a project that was never created starts it, fresh', async () => {
      const { seen, note } = freshRecorder();
      const { provider: infra } = provider({ checked: note });
      expect((await infra.up({ trigger: 'reset', services: ['checked'] })).ok).toBe(true);
      expect(seen).toEqual({ checked: [true] });
    });

    test('a reset of a project with only some services created resets all of them, fresh', async () => {
      const { seen, note } = freshRecorder();
      const { provider: infra } = provider({ checked: note, plain: note, oneshot: note });
      expect((await infra.up({ services: ['plain'] })).ok).toBe(true);
      expect((await infra.up({ trigger: 'reset' })).ok).toBe(true);
      expect(seen).toEqual({ checked: [true], plain: [true, true], oneshot: [true] });
    });

    test('a destroy of a project that was never created succeeds, whole or named', async () => {
      const { provider: infra } = provider();
      expect((await infra.destroy({})).ok).toBe(true);
      expect((await infra.destroy({ services: ['checked'] })).ok).toBe(true);
    });

    test("a whole reset removes a disabled service's volume", async () => {
      const { provider: infra, project } = provider({ plain: { enabled: false, tags: [] } });
      await dockerCompose(project, 'up', '-d', 'plain');
      expect(await volumes(project)).toContain(`${project}_plain-data`);
      expect((await infra.up({ trigger: 'reset' })).ok).toBe(true);
      expect(await volumes(project)).toEqual([`${project}_checked-data`]);
    });

    /** A container of no project holding `volume`, for the length of `body`. */
    async function withOutsider(volume: string, body: () => Promise<void>): Promise<void> {
      const { stdout } = await dockerExec(
        'run',
        '-d',
        '--rm',
        '-v',
        `${volume}:/x`,
        'alpine:3.20',
        'sleep',
        '600',
      );
      try {
        await body();
      } finally {
        await dockerExec('rm', '-f', stdout.trim());
      }
    }

    test('a volume in use by a container outside the project refuses a reset, and nothing is removed', async () => {
      const { provider: infra, project } = provider();
      expect((await infra.up({ services: ['checked'] })).ok).toBe(true);
      const volume = `${project}_checked-data`;
      await withOutsider(volume, async () => {
        await expect(infra.up({ trigger: 'reset', services: ['checked'] })).rejects.toThrow(
          new RegExp(
            `can't reset checked: volume ${volume} is in use by container \\S+, outside this project`,
          ),
        );
        expect(await containers(project)).toContain('checked=running');
        expect(await volumes(project)).toContain(volume);
      });
    });

    test("a disabled service's volume in use outside the project refuses a whole reset, and nothing is removed", async () => {
      const { provider: infra, project } = provider({ plain: { enabled: false, tags: [] } });
      await dockerCompose(project, 'up', '-d', 'plain', 'checked');
      const volume = `${project}_plain-data`;
      await withOutsider(volume, async () => {
        await expect(infra.up({ trigger: 'reset' })).rejects.toThrow(
          new RegExp(`can't reset plain: volume ${volume} is in use by container \\S+, outside this project`), // oxfmt-ignore
        );
        expect(await containers(project)).toEqual(['checked=running', 'plain=running']);
        expect(await volumes(project)).toEqual([`${project}_checked-data`, volume]);
      });
    });

    test('a volume of a service behind a Compose profile, in use outside the project, refuses a whole destroy', async () => {
      fs.writeFileSync(
        path.join(ws, 'compose.yaml'),
        "services:\n  plain:\n    image: alpine:3.20\n    command: 'true'\n  tools:\n    image: alpine:3.20\n    profiles: [tools]\n    command: 'true'\n    volumes: [tools-data:/data]\nvolumes:\n  tools-data:\n", // oxfmt-ignore
      );
      const { provider: infra, project } = provider();
      await dockerCompose(project, '--profile', 'tools', 'up', '-d', 'tools');
      const volume = `${project}_tools-data`;
      await withOutsider(volume, async () => {
        await expect(infra.destroy({})).rejects.toThrow(
          new RegExp(`can't destroy tools: volume ${volume} is in use by container \\S+, outside this project`), // oxfmt-ignore
        );
        expect(await volumes(project)).toEqual([volume]);
      });
    });

    test('a running `compose run` container refuses a reset, named or whole, and nothing is removed', async () => {
      const { provider: infra, project } = provider();
      expect((await infra.up({ services: ['plain'] })).ok).toBe(true);
      const { stdout } = await dockerCompose(project, 'run', '-d', 'plain', 'sleep', '600');
      try {
        const volume = `${project}_plain-data`;
        const refusal = new RegExp(`can't reset plain: volume ${volume} is in use by container \\S+-run-\\S+, which this reset doesn't remove`); // oxfmt-ignore
        await expect(infra.up({ trigger: 'reset', services: ['plain'] })).rejects.toThrow(refusal);
        await expect(infra.up({ trigger: 'reset' })).rejects.toThrow(refusal);
        expect(await containers(project)).toEqual(['plain=running', 'plain=running']);
        expect(await volumes(project)).toEqual([volume]);
      } finally {
        // `down` leaves a running one-off, so the teardown after the test wouldn't take it.
        await dockerExec('rm', '-f', stdout.trim());
      }
    });

    test('a stop of a project that was never created succeeds', async () => {
      const { provider: infra } = provider();
      expect((await infra.down({})).ok).toBe(true);
      expect((await infra.down({ services: ['checked'] })).ok).toBe(true);
    });

    test("a stop with nothing named leaves a disabled service's container and the network", async () => {
      const { provider: infra, project } = provider({ plain: { enabled: false, tags: [] } });
      await dockerCompose(project, 'up', '-d', 'plain');
      expect((await infra.up({})).ok).toBe(true);
      expect((await infra.down({})).ok).toBe(true);
      expect(await containers(project)).toEqual(['plain=running']);
      expect(await networks(project)).toEqual([`${project}_default`]);
    });

    test('down removes the containers and keeps the volumes', async () => {
      const { provider: infra, project } = provider();
      await infra.up({});
      expect((await infra.down({})).ok).toBe(true);
      expect(await containers(project)).toEqual([]);
      expect(await volumes(project)).toEqual([`${project}_checked-data`, `${project}_plain-data`]);
    });

    test("a service's stop and destroy hooks run around the real stop and removal", async () => {
      const seen: string[] = [];
      let project = '';
      const state = async () => (await containers(project)).filter((c) => c.startsWith('plain=')).join() || 'no container'; // oxfmt-ignore
      const volume = async () => ((await volumes(project)).includes(`${project}_plain-data`) ? 'volume' : 'no volume'); // oxfmt-ignore
      const made = provider({
        plain: {
          enabled: true,
          tags: [],
          lifecycle: {
            beforeStop: async ({ trigger }) =>
              void seen.push(`beforeStop:${trigger} ${await state()}`),
            afterStop: async ({ trigger }) =>
              void seen.push(`afterStop:${trigger} ${await state()}`),
            beforeDestroy: async ({ trigger }) => void seen.push(`beforeDestroy:${trigger} ${await volume()}`), // oxfmt-ignore
            afterDestroy: async ({ trigger }) => void seen.push(`afterDestroy:${trigger} ${await volume()}`), // oxfmt-ignore
          },
        },
      });
      project = made.project;
      const infra = made.provider;
      expect((await infra.up({ services: ['plain'] })).ok).toBe(true);
      expect((await infra.down({ services: ['plain'] })).ok).toBe(true);
      // The hook before the stop sees the container up; the one after it, stopped or gone.
      expect(seen[0]).toBe('beforeStop:stop plain=running');
      expect(seen[1]).toMatch(/^afterStop:stop (plain=exited|no container)$/);
      expect((await infra.up({ services: ['plain'] })).ok).toBe(true);
      expect((await infra.destroy({ services: ['plain'] })).ok).toBe(true);
      expect(seen.slice(2)).toEqual(['beforeDestroy:destroy volume', 'afterDestroy:destroy no volume']); // oxfmt-ignore
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
