```bash
# fresh test databases, migrated and seeded
sctl --profile test infra reset
# the frontend, and the backend it waits for
sctl --profile test start --tag browser --detach
# every command from here on runs in the test profile
export STACKCTL_PROFILE=test
sctl exec --tag browser -- \
  vitest --config ./vitest.config.e2e.ts
sctl stop
```
