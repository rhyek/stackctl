import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

export type ReconcileOutcome = 'created' | 'updated' | 'unchanged';

/** The tsconfig scaffolded when the workspace root has none. */
function defaultTsconfig(configFile: string): string {
  return `{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": [${JSON.stringify(configFile)}]
}
`;
}

/**
 * Pure core of {@link reconcileTsconfig}: given the current `tsconfig.json` text (or `null`
 * when there is none) and the config filename to include, returns the reconciled text.
 *
 * - `null` → a full default tsconfig that loads node types and includes `configFile`.
 * - existing → surgically (comments/formatting preserved) ensures `configFile` is in
 *   `include`, and adds `"node"` to `compilerOptions.types` **only** when that's already an
 *   array missing it (an absent `types` is left as-is). Never overwrites other settings.
 */
export function reconcileTsconfigText(
  currentText: string | null,
  configFile: string,
): { text: string; outcome: ReconcileOutcome } {
  if (currentText === null) {
    return { text: defaultTsconfig(configFile), outcome: 'created' };
  }

  const errors: ParseError[] = [];
  const root = parse(currentText, errors, { allowTrailingComma: true }) as unknown;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    // Unparseable or non-object root — leave it untouched rather than risk clobbering.
    return { text: currentText, outcome: 'unchanged' };
  }
  const cfg = root as { include?: unknown; compilerOptions?: { types?: unknown } };

  let text = currentText;

  // 1. include: append configFile to the array, or create the array if there's none.
  if (Array.isArray(cfg.include)) {
    if (!cfg.include.includes(configFile)) {
      text = applyEdits(
        text,
        modify(text, ['include', cfg.include.length], configFile, {
          isArrayInsertion: true,
          formattingOptions: FORMAT,
        }),
      );
    }
  } else {
    text = applyEdits(text, modify(text, ['include'], [configFile], { formattingOptions: FORMAT }));
  }

  // 2. compilerOptions.types: only add "node" when it's already an array missing it.
  const types = cfg.compilerOptions?.types;
  if (Array.isArray(types) && !types.includes('node')) {
    text = applyEdits(
      text,
      modify(text, ['compilerOptions', 'types', types.length], 'node', {
        isArrayInsertion: true,
        formattingOptions: FORMAT,
      }),
    );
  }

  return { text, outcome: text === currentText ? 'unchanged' : 'updated' };
}

/**
 * Reconciles the `tsconfig.json` at `cwd` so `configFile` (default `stackctl.config.ts`) is
 * type-checked with node globals in scope — preventing the `Cannot find name 'process'`
 * (TS2591) error editors show for `process.env.*` in the scaffolded config. Idempotent.
 */
export function reconcileTsconfig(opts: { cwd: string; configFile?: string }): ReconcileOutcome {
  const configFile = opts.configFile ?? 'stackctl.config.ts';
  const tsconfigPath = path.join(opts.cwd, 'tsconfig.json');

  let current: string | null;
  try {
    current = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    current = null;
  }

  const { text, outcome } = reconcileTsconfigText(current, configFile);
  if (outcome !== 'unchanged') {
    fs.writeFileSync(tsconfigPath, text);
  }
  return outcome;
}
