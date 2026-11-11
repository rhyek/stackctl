# stackctl

Monorepo for the published `stackctl` npm package.

- `packages/stackctl/` — the package source.
- `example/` — a self-contained example monorepo that consumes the package via
  `stackctl: link:../packages/stackctl` (see `example/package.json`).

## NEVER commit personal content — hard rule

This is a **public** repository. Do not put any of the user's personal material into the code,
docs, tests, comments, commit messages, or example/fixture data — **ever**. That includes:

- Personal conversations or message content (texts, DMs, chat/dating-app messages), from any
  source or any language.
- Real names of people, contacts, or private projects; personal locations, travel plans, or
  any other private details lifted from the user's life or communications.

When you need sample data — example log lines, fixtures, test inputs, doc snippets — **invent
neutral, obviously-synthetic technical content** (generic service names, `SELECT` queries,
`foo`/`bar`, placeholder users like `web`/`api`). Never reach for something real the user
happened to mention. If you're unsure whether a value is personal, treat it as personal and
use a neutral placeholder instead. When in doubt, ask before committing.

## Documentation

The documentation is one set of Markdown pages in `docs/`, read three ways:

- **The site, https://stackctl.dev.** VitePress over `docs/` (`docs/.vitepress/config.ts` has
  the nav and sidebar). `pnpm docs:dev` previews it on port 21070; `docs.yaml` deploys it to
  GitHub Pages on a push to `main` that touches `docs/`.
- **`llms.txt`.** `vitepress-plugin-llms` writes an index (`llms.txt`), the whole site in one
  file (`llms-full.txt`) and a Markdown copy of every page into the site build. Each page's
  frontmatter `description` is its line in the index, so write it for an agent choosing what
  to read.
- **Inside the npm package.** `pnpm docs:package` (run by `pnpm build`) builds the site and
  copies `llms.txt` and the pages into `packages/stackctl/docs/` (`scripts/package-docs.ts`),
  which is generated and gitignored. The installed skill reads them from
  `node_modules/stackctl/docs/`, so an agent gets the docs of the installed version. Projects
  that `link:` this package read the same folder: run `pnpm docs:package` after a docs edit.

| Section           | Pages                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| `docs/guide/`     | Getting started, why, services, the terminal UI, environment and modes, one-off commands, logs, tests and CI. How to do things. |
| `docs/config/`    | One page per part of `stackctl.config.ts`: the file itself, services, environment, logs, infra, reverse proxy, URLs and origins. |
| `docs/reference/` | The CLI, the control API (endpoints and payloads), the SDK.                        |
| `docs/ai/`        | `overview.md`: how stackctl serves coding agents. `playbook.md`: recipes written for the agent, the page the skill names. |

`docs/index.md` is the site's home page. `docs/architecture/` is contributor internals and
`docs/superpowers/` working notes: neither is part of the site (`srcExclude`).

`README.md` (repo root) is a short landing page: what stackctl is, the demo, install, a quick
start, and links to the site. Its links are absolute, so npm and GitHub render it alike;
`release.yaml` copies it into the package as it is.

`packages/stackctl/assets/skill.md` is the installed skill: frontmatter, a few rules, and an
instruction to Read `node_modules/stackctl/docs/ai/playbook.md` and `llms.txt`. Put content in
the docs, not here. The paths are deliberately **not** `@` references: `@` force-loads the whole
file on invocation, which defeats the progressive disclosure a skill exists to provide.

- **Frontmatter must start on line 1.** `renderSkill` stamps the managed banner as a YAML
  comment *inside* the frontmatter for exactly this reason. A banner above the `---` means
  the block is never parsed as frontmatter, and the skill's `description` — the only basis
  on which it is ever invoked — is lost, silently. `skill.spec.ts` guards this; don't move
  the banner.

### Keep the docs in lockstep

Whenever a change affects how stackctl is configured, invoked, or driven — `defineConfig`
options, the service schema, tokens, CLI flags, the control API, the SDK — update the docs
in the same change, not later. Grep `docs/guide`, `docs/config`, `docs/reference`, `docs/ai`,
the README and `assets/skill.md` for the affected names and reconcile every hit.

- **One home per fact.** A config option is documented on its `docs/config/` page, a command
  on `reference/cli.md`, an endpoint on `reference/control-api.md`. Guide pages and the
  playbook show the flow and link there; they don't repeat the details.
- **Agents read the same pages.** There is no separate agent guide. Whatever an agent needs to
  get a call right goes in the page that owns the topic.
- **Short and familiar.** Lead with an example, then a table of options, then one-line bullets
  for the rules. Internals (how a feature is built) belong in `docs/architecture/`.
- **Links between pages are relative and end in `.md`** (`../config/infra.md#callbacks`), so
  they work on the site, on GitHub and in the packaged copies. Heading anchors are GitHub's
  (the site's `slugify` matches). `pnpm docs:build` fails on a dead link, and
  `scripts/package-docs.ts` on a packaged link that leads nowhere.
- **A new page** goes in the sidebar in `docs/.vitepress/config.ts`, with a `description`.
- **A screen of the terminal UI is a recording**, not a hand-drawn block: a `<TerminalPlayer>`
  the site plays, beside the text copy llms.txt reads. Each is a scene in `scripts/demo/scenes.ts`,
  with the files that can change it; when the screen it shows changes, re-record it with
  `./scripts/demo/record.sh <scene>`, which the `/commit` skill does for you. See
  [`scripts/demo/CLAUDE.md`](scripts/demo/CLAUDE.md).
- **Only the current surface, no history:** see
  [`.claude/rules/docs-no-history.md`](.claude/rules/docs-no-history.md), which loads whenever
  one of these files is read or edited.
- **Hand-formatted.** Never run a Markdown formatter on the docs or the README.
- **One description everywhere.** The headline and the one-line description read the same in
  the README, the site, `package.json`, `stackctl --help` and the GitHub repo's settings:
  [`.claude/rules/project-wording.md`](.claude/rules/project-wording.md).

## Building

Build with:

```sh
pnpm build
```

The root `build` script runs `pnpm --filter stackctl build`, which cleans
`dist/`, compiles with `tsc -p tsconfig.build.json`, and marks the compiled CLI
(`dist/cli.js`) executable, then `pnpm docs:package`, which builds the docs site and copies
its `llms.txt` and pages into `packages/stackctl/docs/`. CI (`.github/workflows/ci.yaml`, which `release.yaml` also
calls) uses this same command.

## Changelog and releases

A merged pull request whose `CHANGELOG.md` has a new top `## X.Y.Z` heading **is** a release:
`release.yaml` publishes it on the merge. `main` takes changes only through pull requests
(`.github/rulesets/main.json`). [RELEASING.md](RELEASING.md) has the flow and the one-time setup.

- **Write the entry in the feature branch**, in the same change, for anything a user of
  stackctl would notice: one sentence with a bold summary, grouped as RELEASING.md shows.
- **A released version takes no new entries.** If the top heading is already released (it has
  a `v<version>` tag), add a new heading above it rather than appending; CI's
  `node scripts/changelog.ts check` fails the pull request otherwise. Rewording a released
  entry, or fixing its link, is fine.
- **No entry means no release.** A change nobody using stackctl would notice (docs, tests,
  refactors, CI) adds none, and merging it publishes nothing.

## Type-level tests — assert types, not "some error"

`defineConfig`'s inference (per-service `tokens`, the service-name union, the callback `port`)
is asserted in `packages/stackctl/src/config.test-d.ts` with vitest's `expectTypeOf`
(`expect-type`, already a vitest dependency — nothing to install):

```sh
pnpm test:types      # vitest --typecheck.only --run
```

**`expectTypeOf` is a no-op without `--typecheck`** — it compiles and "passes" under plain
`pnpm test`, which is why the assertions live in `*.test-d.ts` and get their own script and CI
step. `vitest.config.ts` points `typecheck.tsconfig` at `packages/stackctl/tsconfig.typecheck.json`,
which is the normal tsconfig minus three spec files that already fail typecheck on main — so a
real type error anywhere else still fails the run rather than being blanket-ignored.

Prefer these over `@ts-expect-error`. A `@ts-expect-error` passes when the line errors for *any*
reason, which has already hidden a bug here: an assertion meant to prove a token typo was
rejected was really only passing because the value was `string | undefined`. Assert the type
instead — `expectTypeOf(ctx.port).toEqualTypeOf<number>()`, or
`expectTypeOf(ctx.tokens).not.toHaveProperty('region')`. Keep `@ts-expect-error` only for
things that are genuinely "this must not compile" (an unknown field, a bad `waitFor` name), and
when you write one, confirm it fails for the intended reason.

A config field lives in two places: its Zod schema in `config-schema.ts`, which validates, and its
type in `config.ts` (`ServiceConfigInput` / `DefineConfigOptions`), which carries its JSDoc. The
schema holds no docs. `config.test-d.ts` compares the two, so `pnpm test:types` fails until a new
or changed field agrees in both. Declare each field directly on those object types, not through
`Omit`/`Pick`: TypeScript 7.0's editor shows no hover docs for a field reached through a mapped
type.

## Testing changes in `./example`

After **any** change to `packages/stackctl`, rebuild so the change is picked up
in the example:

```sh
pnpm build
```

Because `example/` links the package directly (`link:../packages/stackctl`), the
freshly built `dist/` is used immediately — no reinstall needed. Then run the
example:

```sh
cd example && pnpm dev   # runs the `stackctl` bin
```

## Testing changes end to end (`pnpm test:e2e`)

```sh
pnpm test:e2e   # about 25 s; needs python3, nothing else
```

`packages/stackctl/e2e/` runs the real CLI on a pseudo-terminal: `pty_driver.py` (Python's stdlib
`pty`, since Node has none) relays the bytes, and `pty.ts` plays them into a small VT screen
(`screen.ts`), types keys and SGR mouse clicks, and waits for what the screen shows. Each file gets
a temp workspace (`fixture.ts`) with three plain Node services, `api`, `web` (which waits for
`api`) and `worker`, on ports 21080–21089, and its own CLI build under
`node_modules/.cache/cli-e2e`, so it never needs `dist/`. `pnpm test` doesn't pick these files up
(`*.e2e.spec.ts`, `vitest.e2e.config.ts`); CI runs both.

It covers the picker (keys, clicks, a locked dependency's toast, the filter) and the step into the
run screen with its startup footer; footer clicks and the commands menu; the log filter; Ctrl+C
once and twice; a SIGTERM at the first frame; a failed startup; a crash; and, without a TTY, a
headless run, `start --detach` + `stop`, and a `--kill-others` takeover. Each exit is checked for
its code and for the terminal given back (mouse reporting off, the alternate screen left).

Infra, the dev reverse proxy and the `R` reset stay manual: drive them through the PTY with the
`testing-behavior-with-pty` skill against `example/`.

## Terminal UI rendering (internals)

The interactive TUI is a **fullscreen alternate-screen app**: Ink owns the whole
viewport, a **virtualized `LogPane`** renders only the log rows that fit the
screen (from the session's subscribable `LogStore`), and the footer is pinned to
the bottom by flex layout. The runtime lives in `src/session/` (`Session`, the
façade the TUI, headless mode and the control API share, over `Supervisor`,
`ServiceProcess`, `Readiness`, `LogStore` and `log-layout`); the screens in
`src/tui/` (`App` → `Picker` → `RunScreen`), each a pure reducer (`ui-state.ts`,
`picker-state.ts`) and a pure layout (`layout.ts`, `picker-layout.ts`) that
feeds both drawing and click hit-testing, with every hint generated from a key
table (`keymap.ts`). Mouse-wheel + keyboard scrolling replace the terminal's
native scrollback, everything selectable is clickable (`use-mouse.ts`), and text
selection is **app-managed** (SGR mouse reporting + drag-to-copy) since native
selection can't survive Ink's in-place repaints. Before changing anything about
the log viewport, scrolling, the footer, the commands menu, the picker, clicks,
selection, or how output reaches the screen, read
[`docs/architecture/rendering.md`](docs/architecture/rendering.md) — it has the
module map, the layouts and hit-testing, the virtualization
(`log-window.ts`/`scroll.ts`), the store subscription, and the
mouse/selection/clipboard handling. Shutdown (the one path in
`Session.shutdown`, the screen's part in `tui/shutdown.ts`, the exit line,
releasing the mouse) is in
[`docs/architecture/exiting.md`](docs/architecture/exiting.md). (Internal
contributor docs — not part of the site.)
