---
description: How stackctl loads .env files per workspace, service and mode, which value wins, the variables it sets itself, and how modes keep sessions apart.
---

# Environment and modes

stackctl loads `.env` files for every service it runs and injects them into that service's
process. You don't call `dotenv` anywhere. Parsing is done by
[dotenvx](https://github.com/dotenvx/dotenvx), so `${VAR}` references expand.

## Which files load

Files are read at two scopes, the workspace root and the service's own directory:

```
your-monorepo/
├── .env                     # workspace: every service
├── .env.local
├── .env.development
└── apps/
    └── api/
        ├── .env             # service: only api, overrides the workspace's
        └── .env.local
```

At each scope, in this order, each overriding the one before:

1. `.env`
2. `.env.local`
3. `.env.<mode>`
4. `.env.<mode>.local`

Only files that exist are read. Commit `.env` and `.env.<mode>`, and keep `.env*.local` out of
git for personal overrides.

## Which value wins

From lowest to highest:

1. [`env.vars`](../config/env.md#envvars), variables set in the config.
2. The workspace's files.
3. The service's files.
4. **The environment stackctl was started with.** `LOG_LEVEL=debug stackctl` overrides every
   file for one run, as in Vite, Next.js and `node --env-file`.

To let a file win over the shell for some variables (a `NODE_OPTIONS` that extends the
inherited one, say), name them in [`env.override`](../config/env.md#envoverride). To load
files of your own between stackctl's, use
[`env.additionalFiles`](../config/env.md#envadditionalfiles).

## Modes

A mode picks the `.env.<mode>` files, and gives the session its own state.

```sh
stackctl                 # development
stackctl --mode test     # .env.test and .env.test.local
```

- **Without `--mode`**, the mode is `STACKCTL_MODE` if set, else `test` in CI (`CI` set and not
  `false` or `0`), else `development`.
- **Any name works**: `test`, `staging`, `e2e`.
- **Modes are exclusive.** `--mode test` does not read `.env.development`. Put shared values
  in `.env`.
- **One session per mode.** A `test` session runs next to your `development` one, each with its
  own processes, [infra containers](../config/infra.md#modes) and state under
  `node_modules/.stackctl/modes/<mode>/`. Give each mode its own ports in its `.env.<mode>`.
- **`NODE_ENV` is left alone.** Set it in the mode's file if you want it: `NODE_ENV=test` in
  `.env.test`.

Starting a second session in the *same* mode
[takes over](../reference/cli.md#taking-over-a-running-session) the first.

## Variables stackctl sets

Every process stackctl starts gets these:

| Variable                 | Value                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- |
| `PORT`                   | The service's [`port`](../config/services.md#port).                           |
| `PUBLIC_ORIGIN`          | Where a browser reaches the service. See [URLs and origins](../config/urls.md). |
| `STACKCTL_MODE`          | The active mode.                                                              |
| `STACKCTL_WORKSPACE_DIR` | The workspace root: the directory holding `stackctl.config.ts`.               |
| `STACKCTL_CWD`           | The directory stackctl was invoked in.                                        |
| `NODE_EXTRA_CA_CERTS`    | With the proxy's [`tls: true`](../config/reverse-proxy.md#tls): its certificates. |

`PORT` and `PUBLIC_ORIGIN` win over a value set workspace-wide. Only the service's own `.env`
file overrides them.

The three `STACKCTL_*` variables are set before the config loads, so a `.env` file can
reference them (`UPLOADS=${STACKCTL_WORKSPACE_DIR}/.data`), and config callbacks find them in
`envs`.

## Live reload

While a session runs, stackctl watches the `.env` files, and the places new ones would appear.
When a file's content changes, the services that read it restart: a workspace file restarts
every running service, a service's file only that one. Symlinked files are followed. A write
that changes nothing (a `touch`) restarts nothing.

Values the config computed are the exception: `env.vars` and callbacks such as `port` run once,
when stackctl starts. Restart stackctl to pick those up.

## The same environment anywhere

- [`stackctl exec` and `stackctl run`](./commands.md) run one command with a service's
  environment.
- [`resolveEnv()`](../reference/sdk.md#resolveenv) returns it to a script.
- [`stackctl show-config`](../reference/cli.md#stackctl-show-config) lists, under `envFiles`,
  the files a mode looks for. Check there when a variable is missing.

## Details

- **`${VAR}` expands to the value that wins** for that variable: the shell's, or an
  already-loaded file's when the shell has none or `env.override` names it.
- **A file that can't be read yet holds the services, not the session.** macOS, for one,
  blocks a read of a Dropbox or iCloud folder until you allow access. The services show as
  `waiting`, the log names the file, and the session still answers its control API.
- **Nested stackctl.** A process stackctl started also gets `STACKCTL_INJECTED_ENV`, the names
  of the variables stackctl gave it. A stackctl started from that process (an e2e suite that
  calls `startStack()`, say) drops them first, so its own `.env` files load as from a clean
  shell. It stays in the outer mode unless `--mode` says otherwise.
