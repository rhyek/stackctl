import { loadedConfigOrExit } from './workspace.js';

// The read-only command that prints what the config resolves to.

/** `stackctl show-config`: the fully resolved config, as JSON. */
export async function showConfig(): Promise<never> {
  // The config is resolved exactly once, when the file loads (callbacks run, defaults applied,
  // `command` normalized); this is that object, serialized the way the control API serves it.
  // Function-valued fields (`logs.formatter`) have no JSON form and are omitted, there too.
  console.log(JSON.stringify(await loadedConfigOrExit(), null, 2));
  process.exit(0);
}
