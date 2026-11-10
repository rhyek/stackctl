import fs from 'node:fs';
import path from 'node:path';
import { intro, outro, confirm, isCancel, cancel, log } from '@clack/prompts';
import { findConfigPath } from './load-config.js';
import { installSkill, isSkillInstalled, readOwnVersion } from './skill.js';
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
 * untouched (pass `force: true` to overwrite). An already-installed agent skill is
 * refreshed automatically without prompting (it's a managed file); the install prompt only
 * appears for a first-time install. Pass `yes: true` for a non-interactive run that accepts
 * the defaults (install the agent skill) without prompting — used by `-y/--yes` and by
 * automation.
 *
 * Does NOT prompt for a log location — each run writes a fresh timestamped log under
 * `node_modules/.stackctl/`, and the directory is only overridable via the `--log-dir` CLI flag.
 */
export async function runInit(
  opts: { cwd?: string; force?: boolean; yes?: boolean } = {},
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const existingConfig = findConfigPath(cwd);

  intro('stackctl init');

  // An already-installed skill is a managed file — refresh it without asking. The prompt
  // only appears for a first-time install; --yes always installs without prompting.
  const skillInstalled = isSkillInstalled(cwd);
  let skill: boolean;
  if (opts.yes || skillInstalled) {
    skill = true;
  } else {
    const skillAnswer = await confirm({
      message: 'Install the stackctl agent skill?',
      initialValue: true,
    });
    if (isCancel(skillAnswer)) {
      cancel('Setup cancelled.');
      return;
    }
    skill = skillAnswer;
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

  if (skill) {
    installSkill({ cwd, version: readOwnVersion() });
    log.step(skillInstalled ? 'Updated agent skill' : 'Installed agent skill');
  }

  outro('stackctl is set up.');
}
