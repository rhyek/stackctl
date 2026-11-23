```ts
// scripts/e2e.ts
import { exec, infra, startStack } from 'stackctl';

// fresh test databases, migrated and seeded
await infra.reset({ profile: 'test' });

// the frontend, and the backend it waits for
const stack = await startStack({
  profile: 'test',
  tags: ['browser'],
});

// the browser tests, with the frontend's environment
await exec({
  profile: 'test',
  tags: ['browser'],
  command: ['vitest', '--config', './vitest.config.e2e.ts'],
});

await stack.stop();
```
