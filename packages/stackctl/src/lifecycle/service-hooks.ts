import { type AnyServiceConfig, type Config, serviceBuildAddress, serviceDetails } from '../config';
import { errorMessage } from '../errors';
import type { Exec } from '../spawn';
import { type HookOutcome, lifecycleContext, runHook } from './hooks';
import type {
  ServiceCallbacks,
  ServiceHookContext,
  ServiceStartTrigger,
  ServiceStopTrigger,
} from './service-types';

/** The application services' `lifecycle` hooks, as the supervisor runs them. */
export interface ServiceHooks {
  /** Whether the service called `name` has `hook`. */
  has(name: string, hook: keyof ServiceCallbacks): boolean;
  /**
   * Runs the service's `hook`, if it has one, for a start or stop `trigger` caused, with `data`
   * as its `data`. With a `budget`, the hook is abandoned once it aborts, and the commands it runs
   * are ended: SIGTERM, then a kill if one still runs a moment later. Never rejects: the outcome
   * says how it ended, a failure to build its context included.
   */
  run(
    name: string,
    hook: keyof ServiceCallbacks,
    trigger: ServiceStartTrigger | ServiceStopTrigger,
    data: Record<string, unknown>,
    budget?: AbortSignal,
  ): Promise<HookOutcome>;
  /**
   * Resolves once every command the service's hooks have started with `exec` has ended, at once
   * when none runs: what a step that follows an abandoned hook waits for.
   */
  commandsEnded(name: string): Promise<void>;
}

/**
 * The hooks of `config`'s services. Each gets the service's details and `buildAddress` as its
 * `urls` callbacks got them, its tokens, the environment its dev process gets (`envFor`) and
 * `exec` in its directory; what it logs, and what its commands print, goes to `write` under the
 * service's name.
 */
export function createServiceHooks(opts: {
  config: Config<string>;
  /** The environment the service's dev process gets. */
  envFor: (service: AnyServiceConfig) => Record<string, string>;
  /** Writes a line under the service's label. */
  write: (service: string, line: string, isError: boolean) => void;
  /** Runs the hooks' commands; the real thing unless a spec stands in. */
  exec?: Exec;
  /** Aborting it kills the command any hook is running, at once: the session's hard kill. */
  signal?: AbortSignal;
}): ServiceHooks {
  const { config } = opts;
  /** The commands each service's hooks run now. */
  const commands = new Map<string, Set<Promise<void>>>();
  const track = (name: string, ended: Promise<void>) => {
    const running = commands.get(name) ?? new Set();
    commands.set(name, running);
    running.add(ended);
    void ended.then(() => running.delete(ended));
  };
  const hookOf = (name: string, hook: keyof ServiceCallbacks) =>
    Object.hasOwn(config.services, name) ? config.services[name]!.lifecycle?.[hook] : undefined;
  return {
    has: (name, hook) => typeof hookOf(name, hook) === 'function',
    run: async (name, hook, trigger, data, budget) => {
      const fn = hookOf(name, hook) as
        | ((ctx: ServiceHookContext) => void | Promise<void>)
        | undefined;
      if (!fn) {
        return 'none';
      }
      let ctx: ServiceHookContext;
      try {
        const service = config.services[name]!;
        ctx = {
          ...lifecycleContext({
            config,
            profile: config.profile,
            workspaceDir: config.workspaceDir,
            // The config's tokens with the service's own over them, as the config resolved them.
            tokens: service.tokens,
            envs: opts.envFor(service),
            dir: service.resolvedDir,
            write: (line, isError) => opts.write(name, line, isError),
            data,
            run: opts.exec,
            signal: opts.signal,
            abandon: budget,
            onCommand: (ended) => track(name, ended),
          }),
          trigger,
          service: serviceDetails(service),
          buildAddress: serviceBuildAddress(service, config),
        };
      } catch (err) {
        return { error: errorMessage(err) };
      }
      return runHook(fn, ctx, { budget });
    },
    commandsEnded: async (name) => {
      await Promise.all(commands.get(name) ?? new Set<Promise<void>>());
    },
  };
}
