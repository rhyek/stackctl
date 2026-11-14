import fs from 'node:fs';
import path from 'node:path';
import { intro, outro, log } from '@clack/prompts';
import { guidanceState, installGuidance, missesOwnFiles, offerGuidance } from './agent-guidance.js';
import { findConfigPath } from './load-config.js';
import { readOwnVersion } from './skill.js';
import { reconcileTsconfig } from './tsconfig.js';

/** The scaffolded `stackctl.config.ts`. */
function configTemplate(): string {
  return `import { defineConfig } from 'stackctl';

export default defineConfig({
  // Where the services live: each one's directory is \`<serviceRootDir>/<key>\` unless it sets
  // \`relativeDir\` itself.
  serviceRootDir: 'apps',
  // Keyed by service name — the key is the name, so there's no \`name\` field.
  services: {
    // api: { port: 3001 },
  },
});
`;
}

/**
 * `stackctl init` setup flow. Idempotent: an existing `stackctl.config.ts` is left
 * untouched (pass `force: true` to overwrite).
 *
 * What it installs for coding agents (see `agent-guidance.ts`):
 *
 * - **Interactively**, it asks one question: whether to install stackctl's own files. What is
 *   already installed is rewritten without asking, and when they are all there it asks nothing.
 * - **With `yes: true`** (`-y/--yes`, automation) it accepts the defaults without prompting:
 *   stackctl's own files, and no `AGENTS.md` section.
 * - **`agentsMd: true`** (`--agents-md`) adds the section either way.
 * - **`guidance: false`** installs none of it: the postinstall's choice, since an install
 *   shouldn't put files in a repo unasked.
 *
 * Does NOT prompt for a log location: each session writes its log in a folder of its own under
 * `node_modules/.stackctl/profiles/<profile>/sessions/`.
 */
export async function runInit(
  opts: {
    cwd?: string;
    force?: boolean;
    yes?: boolean;
    agentsMd?: boolean;
    guidance?: boolean;
  } = {},
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const version = readOwnVersion();
  const existingConfig = findConfigPath(cwd);

  intro('stackctl init');

  // What is installed is a managed file: rewritten without asking. The prompt only appears
  // while one of stackctl's own files is missing; --yes takes its defaults.
  const state = guidanceState(cwd);
  let own = !missesOwnFiles(state);
  let block = state.block || opts.agentsMd === true;
  let asked: string[] | null | undefined;
  if (opts.guidance === false) {
    own = false;
    block = false;
  } else if (missesOwnFiles(state)) {
    if (opts.yes) {
      own = true;
    } else {
      asked = await offerGuidance({ cwd, version });
    }
  }

  const configPath = path.join(cwd, 'stackctl.config.ts');
  if (opts.force || !existingConfig) {
    fs.writeFileSync(configPath, configTemplate());
    log.step('Scaffolded stackctl.config.ts');
  } else {
    log.step(`Kept existing ${path.basename(existingConfig)}`);
  }

  // Make sure a root tsconfig type-checks the config with node globals in scope, so editors
  // don't flag `process.env.*` in it with TS2591. Idempotent; never clobbers existing settings.
  const configFile = path.basename(existingConfig ?? configPath);
  const tsOutcome = reconcileTsconfig({ cwd, configFile });
  if (tsOutcome === 'created') {
    log.step('Created tsconfig.json');
  } else if (tsOutcome === 'updated') {
    log.step(`Added ${configFile} to tsconfig.json include`);
  }

  const done = [
    ...(asked ?? []),
    // after the prompt, only what it didn't already write
    ...installGuidance({
      cwd,
      version,
      own: own && asked === undefined,
      agentsMd: block,
    }),
  ];
  for (const line of done) {
    log.step(line);
  }

  outro('stackctl is set up.');
}
