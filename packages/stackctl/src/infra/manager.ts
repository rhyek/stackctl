import path from 'node:path';
import { getConfigTokens, getWorkspaceDir, type Config } from '../config.js';
import type { ControlClient } from '../control-client.js';
import {
  baseEnvs,
  envCandidatePaths,
  EnvFileSnapshot,
  envKeysFile,
  workspaceEnvLayer,
} from '../env.js';
import { connectSessionControl } from '../find-session.js';
import { findConfigPath } from '../load-config.js';
import { execLines, spawnInherit, type Exec, type SpawnInherit, type Stream } from './exec.js';
import type { InfraProvider, InfraRunRequest, InfraWatch, ProviderRuntime } from './provider.js';
import { DockerComposeProvider } from './providers/docker-compose.js';
import {
  InfraError,
  unknownServicesError,
  type InfraRunSummary,
  type InfraServiceState,
} from './types.js';

/** The command runners a manager's providers use; a session passes none and gets the real ones. */
export interface InfraManagerDeps {
  exec?: Exec;
  spawnInherit?: SpawnInherit;
  stream?: Stream;
  /** Finds the running session for a callback's `control`; defaults to {@link connectSessionControl}. */
  connectControl?: () => Promise<ControlClient | undefined>;
}

/**
 * The one entry point to infra. It builds a provider per key under the config's `infra`, routes
 * a service name to the provider that has it, and is what the `infra` commands, `--headless` and
 * the TUI all call — none of them talks to a provider.
 */
export class InfraManager {
  constructor(private readonly providers: InfraProvider[]) {}

  /**
   * The manager for a resolved config, or `null` when it declares no `infra`. Reads the
   * workspace's `.env` files off this thread (see {@link EnvFileSnapshot} for why).
   */
  static async fromConfig(
    config: Config<string>,
    deps: InfraManagerDeps = {},
  ): Promise<InfraManager | null> {
    if (!config.infra) {
      return null;
    }
    const workspaceDir = getWorkspaceDir();
    const envFiles = new EnvFileSnapshot();
    await envFiles.refresh([
      envKeysFile(),
      ...envCandidatePaths({ cwd: workspaceDir, relativeDir: '.', files: config.envFiles }),
    ]);
    const runtime: ProviderRuntime = {
      workspaceDir,
      mode: config.envMode,
      config,
      // The same environment a workspace-scope config callback sees: the config's own variables
      // and the mode's `.env` files, and the ambient environment, which wins over both except
      // where `env.override` says.
      envs: Object.assign(
        baseEnvs(workspaceDir),
        workspaceEnvLayer({
          cwd: workspaceDir,
          files: config.envFiles,
          override: config.envOverride,
          vars: config.envVars,
          read: envFiles.read,
        }),
      ),
      tokens: getConfigTokens(),
      exec: deps.exec ?? execLines,
      spawnInherit: deps.spawnInherit ?? spawnInherit,
      stream: deps.stream,
      // The session a callback's `control` drives: this config's, in this mode — the same
      // config file a session started here records, wherever the command was run from.
      connectControl:
        deps.connectControl ??
        (() =>
          connectSessionControl({
            workspaceDir,
            configPath:
              findConfigPath(workspaceDir) ?? path.join(workspaceDir, 'stackctl.config.ts'),
            mode: config.envMode,
            apiPort: config.apiPort,
          })),
    };
    const providers: InfraProvider[] = [];
    const compose = config.infra['docker-compose'];
    if (compose) {
      providers.push(new DockerComposeProvider(compose, runtime));
    }
    return new InfraManager(providers);
  }

  /** Brings services up and waits until they are ready. See {@link InfraProvider.up}. */
  async up(req: InfraRunRequest = {}): Promise<InfraRunSummary> {
    return this.acrossProviders(req.services, (provider, services) =>
      provider.up({ ...req, services }),
    );
  }

  /** Removes services and their data. See {@link InfraProvider.destroy}. */
  async destroy(req: Omit<InfraRunRequest, 'trigger'> = {}): Promise<InfraRunSummary> {
    return this.acrossProviders(req.services, (provider, services) =>
      provider.destroy({ ...req, services }),
    );
  }

  /** Stops and removes services, keeping their data. Resolves with the worst exit code. */
  async down(services: string[] = []): Promise<number> {
    const plan = await this.route(services);
    let exitCode = 0;
    for (const [provider, names] of plan) {
      exitCode = Math.max(exitCode, await provider.down(names));
    }
    return exitCode;
  }

  /** Memory per running service, across providers. See {@link InfraProvider.readMemory}. */
  async readMemory(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const provider of this.providers) {
      for (const [name, bytes] of await provider.readMemory()) {
        out.set(name, bytes);
      }
    }
    return out;
  }

  /** How each named service stands right now, across providers. See {@link InfraProvider.readStates}. */
  async readStates(services: string[]): Promise<Map<string, InfraServiceState>> {
    const plan = await this.route(services);
    const states = new Map<string, InfraServiceState>();
    for (const [provider, names] of plan) {
      for (const [name, state] of await provider.readStates(names)) {
        states.set(name, state);
      }
    }
    return states;
  }

  /**
   * Reports the named services' states now and whenever they change, across providers — each
   * report the latest reading of every service. See {@link InfraProvider.watchStates}.
   */
  watchStates(
    services: string[],
    onStates: (states: Map<string, InfraServiceState>) => void,
  ): InfraWatch {
    const watches: InfraWatch[] = [];
    let stopped = false;
    const latest = new Map<string, InfraServiceState>();
    void this.route(services).then(
      (plan) => {
        if (stopped) {
          return;
        }
        for (const [provider, names] of plan) {
          watches.push(
            provider.watchStates(names, (states) => {
              for (const [name, state] of states) {
                latest.set(name, state);
              }
              onStates(new Map(latest));
            }),
          );
        }
      },
      () => {
        // A name no provider has: nothing to watch.
      },
    );
    return {
      stop: () => {
        stopped = true;
        for (const watch of watches) {
          watch.stop();
        }
      },
      refresh: () => {
        for (const watch of watches) {
          watch.refresh();
        }
      },
    };
  }

  /** Runs a provider's own tool with `args`, the terminal handed over to it. */
  async passthrough(providerKey: string, args: string[], invocationCwd: string): Promise<number> {
    const provider = this.providers.find((p) => p.key === providerKey);
    if (!provider) {
      throw new InfraError(
        `the config's \`infra\` has no \`${providerKey}\` provider, so there is nothing for ` +
          `\`stackctl infra ${providerKey}\` to run.`,
      );
    }
    return provider.passthrough(args, invocationCwd);
  }

  private async acrossProviders(
    services: string[] | undefined,
    run: (provider: InfraProvider, services: string[]) => Promise<InfraRunSummary>,
  ): Promise<InfraRunSummary> {
    const plan = await this.route(services ?? []);
    const summaries = await Promise.all([...plan].map(([provider, names]) => run(provider, names)));
    return {
      ok: summaries.every((s) => s.ok),
      services: summaries.flatMap((s) => s.services),
    };
  }

  /**
   * Which provider handles which of the named services. No names means every provider, each
   * with an empty list — its own "all of them". A name no provider has is an error listing
   * the real ones.
   */
  private async route(named: string[]): Promise<Map<InfraProvider, string[]>> {
    const plan = new Map<InfraProvider, string[]>();
    if (named.length === 0) {
      for (const provider of this.providers) {
        plan.set(provider, []);
      }
      return plan;
    }
    const owners = new Map<string, InfraProvider>();
    for (const provider of this.providers) {
      for (const name of await provider.listServices()) {
        if (!owners.has(name)) {
          owners.set(name, provider);
        }
      }
    }
    const unknown = named.filter((name) => !owners.has(name));
    if (unknown.length > 0) {
      throw unknownServicesError(unknown, [...owners.keys()]);
    }
    for (const name of named) {
      const provider = owners.get(name)!;
      plan.set(provider, [...(plan.get(provider) ?? []), name]);
    }
    return plan;
  }
}
