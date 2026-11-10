// Lint config for the repo: the shared rules of `@rhyek/oxc-config` (ESLint's and
// typescript-eslint's recommended sets carried over to oxlint, the bug-catching additions, and the
// React set for the Ink components), with this repo's own stricter choices below. Each shared rule,
// and why some are off, is written beside it in `synced-utils/oxc-config/src/oxlint.ts`.
// Formatting is oxfmt's (oxfmt.config.ts).
import { base, ignorePatterns, react } from '@rhyek/oxc-config/oxlint';
import { defineConfig } from 'oxlint';

const NO_UNSAFE = [
  'typescript/no-unsafe-argument',
  'typescript/no-unsafe-assignment',
  'typescript/no-unsafe-call',
  'typescript/no-unsafe-member-access',
  'typescript/no-unsafe-return',
] as const;

export default defineConfig({
  extends: [base, react],
  // Unused disable directives warn, as in ESLint; with --max-warnings=0 that fails the run.
  options: {
    typeAware: true,
    reportUnusedDisableDirectives: 'warn',
  },
  // This is a Node.js CLI project: Node's globals are available everywhere, including plain
  // scripts like postinstall.js.
  env: {
    builtin: true,
    node: true,
  },
  ignorePatterns: [
    ...ignorePatterns,
    // `example/`'s TanStack Start output and generated route tree.
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
  ],
  rules: {
    // A CLI: the console is its output.
    'eslint/no-console': 'off',
    // Stricter than the shared set: no `any` reaches a call, an assignment or a return.
    ...Object.fromEntries(NO_UNSAFE.map((name) => [name, 'error'])),
    'eslint/no-useless-assignment': 'error',
    // No decorators here, so a type-only import says so.
    'typescript/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
    ],
  },
  overrides: [
    // `example/`'s frontend is browser React, not Ink.
    {
      files: ['example/**/*.tsx'],
      env: { browser: true },
    },
    // `example/`'s backend is on Express 5, which passes an `async` handler's rejection to `next`
    // itself, so a plain `async` handler is the documented way to write one.
    {
      files: ['example/apps/backend/**'],
      rules: { 'oxc/no-async-endpoint-handlers': 'off' },
    },
    // Specs and type tests read parsed JSON and asymmetric matchers, which are `any`.
    {
      files: ['**/*.spec.ts', '**/*.test-d.ts'],
      rules: {
        ...Object.fromEntries(NO_UNSAFE.map((name) => [name, 'off'])),
        'typescript/no-explicit-any': 'off',
        'typescript/require-await': 'off',
        'vitest/consistent-test-it': ['error', { fn: 'test', withinDescribe: 'test' }],
      },
    },
    {
      // Type tests assert at compile time, under `vitest --typecheck`.
      files: ['**/*.test-d.ts'],
      rules: { 'vitest/expect-expect': 'off' },
    },
  ],
});
