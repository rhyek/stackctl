# stackctl

This repo's local dev stack is run by stackctl: its dev services, their Docker Compose
infrastructure (database, cache, mail catcher), `.env` loading, logs and test sessions.

Before you start, stop, restart or check a service here, find its URL or port, run its tests,
read its logs, run a command with its environment, touch the database or run `docker compose`,
read `node_modules/stackctl/docs/llms.txt` and the page it names for the task.

- Run it through the package manager (`pnpm stackctl …`): it is not on your `PATH`.
- Never `kill` a stackctl process or free its port by hand: stop and restart through stackctl.
- Never run a bare `docker compose` here: use `stackctl infra`.
