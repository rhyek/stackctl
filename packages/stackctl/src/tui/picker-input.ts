import path from 'node:path';
import { getLoadedConfig, getRegisteredPackages, infraServicesOf } from '../config.js';
import { definesDevScript } from '../scripts.js';
import { dependentsOf, depsOf, displayOrder, planSelection } from '../selection-plan.js';
import { readGitBranch } from '../session/git-branch.js';
import type { PickerInput, SelectionRuns } from './picker-state.js';

/**
 * The picker's view of the loaded config: every registered service in display order, the infra,
 * the saved names, and the rule line's workspace (the footer's: the cwd's name and git branch).
 *
 * A service has a row when it is `selectable` (default `true`) and startable (`definesDevScript`:
 * not `command: null`, and a dev script or target to run). It launches with the session when it
 * is startable and not `autostart: false`.
 */
export function pickerInputOf(saved: readonly string[]): PickerInput {
  const registered = getRegisteredPackages();
  const byName = new Map(registered.map((service) => [service.name, service]));
  return {
    services: displayOrder(registered.map((service) => service.name)).map((name) => {
      const service = byName.get(name)!;
      const startable = definesDevScript(service);
      return {
        name,
        deps: depsOf(name),
        dependents: dependentsOf(name),
        hasRow: service.selectable !== false && startable,
        launches: startable && service.autostart !== false,
      };
    }),
    infra: infraServicesOf(getLoadedConfig()).map((entry) => entry.name),
    saved,
    workspace: { name: path.basename(process.cwd()), branch: readGitBranch() },
  };
}

/** The selection plan's services for the picks: the picker's "will start" line. */
export function planRuns(picked: readonly string[]): SelectionRuns {
  return planSelection([...picked]).services;
}
