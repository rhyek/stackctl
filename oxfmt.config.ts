import { ignorePatterns, oxfmtConfig } from '@rhyek/oxc-config/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...oxfmtConfig,
  // The shared order, with react first after the builtins.
  sortImports: {
    ...oxfmtConfig.sortImports,
    customGroups: [{ groupName: 'react', elementNamePattern: ['react'] }],
    groups: [
      'builtin',
      'react',
      'external',
      ['internal', 'subpath'],
      ['parent', 'sibling', 'index', 'style'],
      'unknown',
    ],
  },
  ignorePatterns: [
    ...ignorePatterns,
    // `example/`'s TanStack Start output and generated route tree.
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
    // README, CHANGELOG and the docs are formatted by hand.
    '**/*.md',
  ],
  overrides: [
    {
      // `example/`'s import order: builtin, react, @tanstack/**, other packages, the workspace's
      // own @example/** packages, the app's ~/ alias, then parent, sibling and index imports.
      files: ['example/**'],
      options: {
        sortImports: {
          ...oxfmtConfig.sortImports,
          internalPattern: [],
          customGroups: [
            { groupName: 'react', elementNamePattern: ['react', 'react-dom', 'react-dom/**'] },
            { groupName: 'tanstack', elementNamePattern: ['@tanstack/**'] },
            { groupName: 'workspace', elementNamePattern: ['@example/**'] },
            { groupName: 'alias', elementNamePattern: ['~/**'] },
          ],
          groups: [
            'builtin',
            'react',
            'tanstack',
            'external',
            'workspace',
            'alias',
            'parent',
            'sibling',
            'index',
            'unknown',
          ],
        },
      },
    },
    {
      // shadcn/ui's CLI output, kept as generated so `shadcn diff` stays clean.
      files: ['example/apps/frontend/src/components/ui/**'],
      options: { sortImports: false },
    },
  ],
});
