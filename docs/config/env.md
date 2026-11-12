---
description: The env option of stackctl.config.ts - env.vars for variables set in the config, env.override to let files win over the shell, and env.additionalFiles for extra .env files.
---

# Environment

The `env` option adjusts how stackctl builds each process's environment.
[Environment and modes](../guide/env.md) explains what loads by default; this page is the
option reference.

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  env: {
    vars: ({ envs }) => ({
      UPLOADS_DIR: `${envs.STACKCTL_WORKSPACE_DIR}/.data/uploads`,
    }),
    override: ['NODE_OPTIONS'],
    additionalFiles: ({ mode }) => [
      { file: `.env.${mode}.pre`, before: 'mode' },
    ],
  },
  services: {/* … */},
});
```

| Option                                    | What it does                                               |
| ----------------------------------------- | ---------------------------------------------------------- |
| [`vars`](#envvars)                        | Sets variables from the config itself.                     |
| [`override`](#envoverride)                | Names variables where a file wins over the shell.          |
| [`additionalFiles`](#envadditionalfiles)  | Loads extra `.env` files among stackctl's own.             |

## `env.vars`

- **Type:** `Record<string, string | undefined> | (ctx) => Record<…>`

Variables for everything stackctl starts: every service, `stackctl exec` and `run`, and
[infra](./infra.md) (Compose and its callbacks).

```ts
env: {
  vars: ({ envs }) => ({
    WORKSPACE_DIR: envs.STACKCTL_WORKSPACE_DIR,
    UPLOADS_DIR: `${envs.STACKCTL_WORKSPACE_DIR}/.data/uploads`,
  }),
},
```

With nothing else under `env`, a callback can stand in for the whole option:
`env: ({ envs }) => ({ … })`.

- **It ranks below every file.** A variable set here behaves like one from a file read before
  `.env`: any `.env` file that defines it wins, and so does the shell.
- **It runs first.** The callback runs once when the config loads, before any other callback,
  so `port`, `urls` and the rest find its result in their `envs`. Its own `envs` is the
  workspace's `.env` files and the shell.
- **A `.env` file can reference it**: `${UPLOADS_DIR}` expands.
- **Values are literal strings.** A `$` is a `$`. `undefined` leaves the variable out.
- **It keeps its value until stackctl restarts**, even when a `.env` file it read changes.
- **It shows in the resolved config.** `stackctl show-config` and the control API print these
  values, so don't compose a secret here.

## `env.override`

- **Type:** `string[] | true`

By default the environment stackctl was started with wins over `.env` files. `override` names
the variables where the files win instead, or `true` for all of them.

```ts
env: { override: ['NODE_OPTIONS'] },
```

It exists for a file that *extends* an inherited value:

```sh
# .env.development
NODE_OPTIONS="$NODE_OPTIONS --disable-warning=ExperimentalWarning"
```

Without the override, that line does nothing whenever the shell already sets `NODE_OPTIONS`,
which VS Code's integrated terminal always does.

`override` only decides between the shell and the files. Between two files, the
higher-ranked one always wins. With `LOG_LEVEL=info` in the workspace's `.env` and
`LOG_LEVEL=warn` in `apps/api/.env`:

| The shell has     | `override`      | `api` gets                              |
| ----------------- | --------------- | --------------------------------------- |
| `LOG_LEVEL=debug` | not set         | `debug`: the shell wins                 |
| `LOG_LEVEL=debug` | `['LOG_LEVEL']` | `warn`: the files win, api's over the workspace's |
| nothing           | either          | `warn`                                  |

## `env.additionalFiles`

- **Type:** `Array<{ file, before | after, scope? }> | ({ mode }) => Array<…>`

Extra `.env` files, each loaded just before or after one of stackctl's four.

```ts
env: {
  additionalFiles: ({ mode }) => [
    { file: `.env.${mode}.pre`, before: 'mode' },
    { file: `.env.${mode}.pre.local`, before: 'mode' },
  ],
},
```

With `--mode development`, each scope then loads `.env`, `.env.local`,
`.env.development.pre`, `.env.development.pre.local`, `.env.development`,
`.env.development.local`.

| Field              | Value                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `file`             | The file's name: a name, not a path. Only a file that exists is read.                       |
| `before` / `after` | Exactly one. The stackctl file it loads next to: `'base'` (`.env`), `'local'` (`.env.local`), `'mode'` (`.env.<mode>`) or `'modeLocal'` (`.env.<mode>.local`). |
| `scope`            | `'workspace'` or `'service'` to look in one place only. Unset: both, like stackctl's own.   |

- **It is an ordinary `.env` file at its place.** A later file wins, and `${VAR}` expands
  against the files before it.
- **Files on the same anchor load in array order.**
- **They are read everywhere stackctl's own are**, and watched the same way: creating, editing
  or removing one restarts the services that read it.
- **Mistakes fail at load**: both or neither of `before` and `after`, a path for `file`, one of
  stackctl's own names, or a duplicate.

### Per-checkout ports

The case it is for: values derived from inputs that differ per checkout. Say each git worktree
gets its own ports, and the committed `.env.development` derives URLs from them:

```sh
# .env.development (committed)
DATABASE_URL=postgres://localhost:${POSTGRES_PORT}/app
API_URL=http://localhost:${API_PORT}
```

A `${VAR}` expands against what was read *before* it, so the ports must load earlier. With
the config above, that is the `.pre` tier:

```sh
# .env.development.pre (committed): the main checkout's ports
POSTGRES_PORT=21000
API_PORT=21001
```

```sh
# .env.development.pre.local (git-ignored): written by a setup script in each worktree
POSTGRES_PORT=21050
API_PORT=21051
```

`.env.development.local` couldn't hold them: it loads after `.env.development`, too late for
the references there.
