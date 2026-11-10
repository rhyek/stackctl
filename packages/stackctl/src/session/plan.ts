import {
  type AnyServiceConfig,
  findService,
  getLoadedConfig,
  normalizeUrlEntry,
} from '../config.js';
import { menuCommandsOf } from '../scripts.js';
import { planSelection } from '../selection-plan.js';
import type { SessionPlan } from './types.js';

/** The services `service` is held until ready: its `deps` entries with `wait`, in the config's order. */
export function waitsFor(service: AnyServiceConfig): string[] {
  return (service.deps ?? []).filter((d) => d.wait).map((d) => d.service);
}

/**
 * The session plan for `selected`, from the selection plan and the loaded config. The caller adds
 * what only it knows: the logfile, and the infra once it is up.
 */
export function buildSessionPlan(selected: string[]): SessionPlan {
  const { services, order } = planSelection(selected);
  const sortedPackages = order.map((name) => findService(name));
  const waitsOn: SessionPlan['waitsOn'] = {};
  const healthchecks: SessionPlan['healthchecks'] = {};
  const menuCommands: SessionPlan['menuCommands'] = {};
  for (const service of sortedPackages) {
    const waits = waitsFor(service);
    if (waits.length > 0) {
      waitsOn[service.name] = waits;
    }
    if (service.healthcheck) {
      healthchecks[service.name] = service.healthcheck;
    }
    const extra = menuCommandsOf(service);
    if (extra.length > 0) {
      menuCommands[service.name] = extra;
    }
  }
  const config = getLoadedConfig();
  return {
    sortedPackages,
    picked: new Set(services.filter((s) => s.why === null).map((s) => s.name)),
    waitsOn,
    healthchecks,
    menuCommands,
    topLevelUrls: config?.urls?.map(normalizeUrlEntry),
    envFiles: config?.envFiles,
    envOverride: config?.envOverride,
    envVars: config?.envVars,
    logTimestamps: config?.logTimestamps,
    cwd: process.cwd(),
  };
}
