import fs from 'node:fs';
import path from 'node:path';
import { getLoadedConfig, getRegisteredPackages } from './config.js';
import { modeStateDir } from './log-files.js';

// The selection the picker saves, and where a session starts from it: the picker, or the saved
// services straight away (`--last-answers`).

/** The active mode's saved selection: `node_modules/.stackctl/modes/<mode>/selection.json`. */
const selectionFile = () => path.join(modeStateDir(process.cwd()), 'selection.json');

/**
 * Keeps only the names that are packages of the loaded config. A saved selection outlives
 * package renames, and a stale name must never reach the picker or `findService` (which throws
 * — inside a React render, that took the whole TUI down), nor be written back to recur on every
 * run. With no config loaded there is nothing to check against, so the names pass through.
 */
function onlyCurrentPackages(names: string[]): string[] {
  if (!getLoadedConfig()) {
    return names;
  }
  const known = new Set(getRegisteredPackages().map((p) => p.name));
  return names.filter((name) => known.has(name));
}

/**
 * Persists the selection for `--last-answers`; a name that isn't a current package is dropped.
 * Only the picker saves it: `-s` and `--last-answers` leave it as it was.
 */
export function saveSelection(names: string[]): void {
  fs.mkdirSync(path.dirname(selectionFile()), { recursive: true });
  fs.writeFileSync(selectionFile(), JSON.stringify(onlyCurrentPackages(names)));
}

/**
 * The saved selection split into the names that are still packages of the loaded config and
 * the ones that aren't (a package key was renamed or removed since); `null` when nothing was
 * ever saved. The pruned list is written back, so a stale name is gone after the first run that
 * reads it — but the caller still learns it was there, since a stale name is what sends the TUI
 * back to the picker instead of replaying the selection.
 */
export function readSelection(): { names: string[]; stale: string[] } | null {
  let saved: string[];
  try {
    saved = JSON.parse(fs.readFileSync(selectionFile(), 'utf8')) as string[];
  } catch {
    return null;
  }
  const names = onlyCurrentPackages(saved);
  const stale = saved.filter((name) => !names.includes(name));
  if (stale.length) {
    try {
      fs.writeFileSync(selectionFile(), JSON.stringify(names));
    } catch {
      // best-effort: the pruned list is still what the caller gets
    }
  }
  return { names, stale };
}

/**
 * Where the interactive session starts, from the CLI flags and the saved selection: the picker,
 * with the `preselected` names checked, or the run screen with `services` started at once.
 */
export type InitialPhase =
  | { type: 'package-select'; preselected: string[] }
  | { type: 'run'; services: string[] };

/**
 * Picks the TUI's first screen: an explicit `--service` list skips the picker and
 * starts those services; so does `--last-answers` with a saved selection whose every name is still
 * a package. A saved selection naming a package that no longer exists shows the picker instead,
 * with the names that survived preselected — renamed package keys must never stop stackctl from
 * running.
 */
export function initialPhaseFor(opts: { packages: string[]; lastAnswers: boolean }): InitialPhase {
  if (opts.packages.length > 0) {
    return { type: 'run', services: opts.packages };
  }
  const saved = readSelection();
  if (opts.lastAnswers && saved && saved.names.length > 0 && saved.stale.length === 0) {
    return { type: 'run', services: saved.names };
  }
  return { type: 'package-select', preselected: saved?.names ?? [] };
}

/**
 * The package names for a `--headless` session, which — unlike the UI — has no
 * selector to fall back on: an explicit `--service` wins, then a saved `--last-answers`
 * selection, otherwise an error naming `usage`. Unknown `--service` names are the caller's to
 * validate.
 */
export function resolveSelectedNames(
  opts: { service: string[]; lastAnswers: boolean },
  usage: string,
): { names: string[] } | { error: string } {
  if (opts.service.length > 0) {
    return { names: opts.service };
  }
  if (opts.lastAnswers) {
    const saved = readSelection();
    // No picker to fall back on here, so a selection with stale names is refused outright
    // rather than run on whatever survived.
    if (saved?.stale.length) {
      return {
        error:
          `The saved selection names services that no longer exist (${saved.stale.join(', ')}) — ` +
          'run once without --last-answers to pick again.',
      };
    }
    return !saved || saved.names.length === 0
      ? { error: 'No saved selection found — run once without --last-answers first.' }
      : { names: saved.names };
  }
  return { error: `${usage} needs services to start: pass --service or --last-answers.` };
}
