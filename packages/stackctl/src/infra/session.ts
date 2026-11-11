import { getLoadedConfig, infraServicesOf } from '../config.js';
import type { InfraLogLine, SessionInfra } from '../session/types.js';
import { InfraManager, type InfraManagerDeps } from './manager.js';
import type { InfraEvent, InfraRunSummary } from './types.js';

/** How many lines of a failed service's output its failure report carries. */
const FAILURE_OUTPUT_LINES = 15;

/**
 * A session's infra step ended with at least one service not ready. The message is the whole
 * report: each failed service and why, followed by the tail of what its callbacks printed —
 * the TUI shows nothing else of that output, and it is usually where the reason is.
 */
export class InfraFailedError extends Error {
  override name = 'InfraFailedError';

  constructor(
    readonly summary: InfraRunSummary,
    log: InfraLogLine[] = [],
  ) {
    super(
      summary.services
        .filter((s) => !s.ok)
        .flatMap((s) => [
          `${s.service}: ${s.error ?? 'failed'}`,
          ...log
            .filter((line) => line.service === s.service)
            .slice(-FAILURE_OUTPUT_LINES)
            .map((line) => `    ${line.text}`),
        ])
        .join('\n'),
    );
  }
}

/**
 * The infra step of a dev session: bring every service up — no reset — and wait, as
 * `stackctl infra start` does, before any package starts. Its callbacks get `session` as their
 * `trigger`. What it prints goes out through `onEvent`. Resolves with what the run phase needs
 * (the services for the footer, with their public origins, a live watch of their states and
 * their memory), or `undefined` when the config declares no `infra`. Throws {@link InfraFailedError} when a service doesn't make it: the
 * packages must not start against infrastructure that isn't there.
 *
 * Nothing here stops the services again — quitting a session leaves them running.
 */
export async function runSessionInfra(
  onEvent?: (event: InfraEvent) => void,
  deps?: InfraManagerDeps,
): Promise<SessionInfra | undefined> {
  const config = getLoadedConfig();
  const manager = config ? await InfraManager.fromConfig(config, deps) : null;
  if (!manager) {
    return undefined;
  }
  const services: SessionInfra['services'] = [];
  // Everything printed on the way up, where a failure's report takes its output from.
  const log: InfraLogLine[] = [];
  const summary = await manager.up({
    trigger: 'session',
    onEvent: (event) => {
      if (event.type === 'targets') {
        const declared = infraServicesOf(config);
        services.push(
          ...event.services.map((name) => ({
            provider: event.provider,
            name,
            urls: declared.find((d) => d.provider === event.provider && d.name === name)?.service
              .urls,
          })),
        );
      } else if (event.type === 'output') {
        log.push({ service: event.service, text: event.line, isError: event.isError });
      }
      onEvent?.(event);
    },
  });
  if (!summary.ok) {
    throw new InfraFailedError(summary, log);
  }
  const names = services.map((service) => service.name);
  return {
    services,
    watch: (onStates) => manager.watchStates(names, onStates),
    readMemory: () => manager.readMemory(),
  };
}
