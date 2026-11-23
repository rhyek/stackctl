import { sdkResultRequested, writeSdkResult } from '../sdk-result';
import { loadedConfigOrExit } from './workspace';

// The read-only command that prints what the config resolves to.

/** `stackctl show-config`: the fully resolved config, as JSON. */
export async function showConfig(): Promise<never> {
  // The config is resolved exactly once, when the file loads (callbacks run, defaults applied,
  // `command` normalized); this is that object, serialized the way the control API serves it.
  // Function-valued fields (`logs.formatter`) have no JSON form and are omitted, there too.
  const config = await loadedConfigOrExit();
  // For `showConfig()`, the result is the config: printing it too would only land on the
  // caller's stderr.
  if (sdkResultRequested()) {
    writeSdkResult(config);
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
  process.exit(0);
}
