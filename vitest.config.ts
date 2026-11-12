import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // the agent eval's guard decides what an agent under test may run: it is tested like the package
    include: ['packages/**/src/**/*.spec.ts', 'maintenance/scripts/agent-eval/**/*.spec.ts'],
    // Restore all spies/mocks to their originals after each test, so a spy left
    // unrestored in one test can't leak into later tests.
    restoreMocks: true,
    // Not a CI run, whatever runs the suite: see the file.
    setupFiles: ['./vitest.setup.ts'],
    // `*.test-d.ts` files assert on types (`expectTypeOf`) and are only meaningful under
    // `--typecheck` — see `pnpm test:types`.
    typecheck: {
      include: ['packages/**/src/**/*.test-d.ts'],
      tsconfig: './packages/stackctl/tsconfig.typecheck.json',
    },
  },
});
