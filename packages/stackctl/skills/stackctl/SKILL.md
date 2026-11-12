---
name: stackctl
description: stackctl runs this repo's local dev stack - its dev services, their Docker Compose infrastructure (database, cache, mail catcher), `.env` loading, logs and test sessions. Use it before you start, stop, restart or check a dev server, app or service here ("is the backend up?", "the app is down"), find the URL or port a service is served at, run tests that call the services, read a service's logs or find out what restarted it, run a command or script with a service's environment, start, restart, reset or inspect the database or run `docker compose`, add or configure a service, or write a CI job that starts the stack.
---

# stackctl

stackctl runs this repo's local dev stack. Its docs ship inside the installed package, so they
match the version in `node_modules`: an index, `llms.txt`, with one line per page, and each page
as Markdown beside it.

**Read the index now, before acting**, with the Read tool, then the page it names for your task:

```
${CLAUDE_PROJECT_DIR}/node_modules/stackctl/docs/llms.txt
```

The index's paths are relative to `node_modules/stackctl/docs/`.

That should already read as an absolute path. If it still shows an unresolved placeholder, your
harness does not substitute it: read `node_modules/stackctl/docs/llms.txt` resolved from the
repository root instead, not from this skill's own directory, which has no `node_modules` under
it.

Nothing loads the docs for you: if you have not run Read, you have not seen them.
