import { getLoadedConfig, getRegisteredPackages, infraServicesOf } from './config.js';

// What a selection starts, in what order, and why each service runs. Everything here reads the
// loaded config and changes nothing in it.

/** What a selection runs: its services with the reason each runs, their order, and the infra. */
export interface SelectionPlan {
  /** Every service the selection runs, in {@link SelectionPlan.order}'s order. */
  services: { name: string; why: string | null }[];
  /** The services' names in the order the session starts and shows them. */
  order: string[];
  /** The infra services the config declares, in declaration order; a session brings up all of them. */
  infra: string[];
}

/**
 * A registered service's direct deps, by name, in the config's order; `[]` for an unknown name.
 * A service listed in its own `deps` is left out: it can't be its own dep.
 */
export function depsOf(name: string): string[] {
  const service = getRegisteredPackages().find((p) => p.name === name);
  return [...new Set((service?.deps ?? []).map((d) => d.service))].filter((dep) => dep !== name);
}

/** The registered services that list `name` as a direct dep, most depended-on first. */
export function dependentsOf(name: string): string[] {
  const dependents = getRegisteredPackages()
    .filter((p) => depsOf(p.name).includes(name))
    .map((p) => p.name);
  return displayOrder(dependents);
}

/**
 * How many registered services need each one, directly or through others. A service never
 * counts itself, and a cycle ends where it closes.
 */
export function dependentScores(): Map<string, number> {
  const scores = new Map(getRegisteredPackages().map((p) => [p.name, 0]));
  for (const { name } of getRegisteredPackages()) {
    const reached = new Set<string>([name]);
    const queue = depsOf(name);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (reached.has(next)) {
        continue;
      }
      reached.add(next);
      scores.set(next, (scores.get(next) ?? 0) + 1);
      queue.push(...depsOf(next));
    }
  }
  return scores;
}

/**
 * `names` in display order: the most depended-on first; among equals, the `selected` ones before
 * the rest; then by name.
 */
export function displayOrder(names: readonly string[], selected: readonly string[] = []): string[] {
  const scores = dependentScores();
  const picked = new Set(selected);
  const score = (name: string) => scores.get(name) ?? 0;
  return [...names].sort(
    (a, b) =>
      score(b) - score(a) || Number(picked.has(b)) - Number(picked.has(a)) || a.localeCompare(b),
  );
}

/**
 * What `selected` runs: those services and each one's direct deps, nothing further. A name that
 * isn't a registered service is ignored. A dep's reason names the first selected service, in
 * display order, that lists it.
 */
export function planSelection(selected: string[]): SelectionPlan {
  const registered = new Set(getRegisteredPackages().map((p) => p.name));
  const picked = [...new Set(selected)].filter((name) => registered.has(name));
  const pickedSet = new Set(picked);
  const pulledIn = [...new Set(picked.flatMap(depsOf))].filter((name) => !pickedSet.has(name));
  const order = displayOrder([...picked, ...pulledIn], picked);
  const pickedInOrder = order.filter((name) => pickedSet.has(name));
  const why = (name: string): string | null => {
    if (pickedSet.has(name)) {
      return null;
    }
    const dependent = pickedInOrder.find((p) => depsOf(p).includes(name));
    return `runtime dep of ${dependent!}`;
  };
  return {
    services: order.map((name) => ({ name, why: why(name) })),
    order,
    infra: infraServicesOf(getLoadedConfig()).map((entry) => entry.name),
  };
}
