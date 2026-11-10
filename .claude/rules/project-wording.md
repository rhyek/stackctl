---
paths:
  - "README.md"
  - "docs/index.md"
  - "docs/.vitepress/config.ts"
  - "packages/stackctl/package.json"
  - "packages/stackctl/src/cli.ts"
---

# How stackctl describes itself — one wording, everywhere, in lockstep

stackctl's name, headline and one-line description appear in several places that people meet
first: the README, the site's home page, search results, the npm page, `stackctl --help` and
the GitHub repo. **They say the same thing, word for word.** A change to one is a change to all
of them, in the same change.

| Text            | Wording                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| **Headline**    | Run your monorepo's stack in one terminal.                                                      |
| **Description** | A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development. |
| **Homepage**    | https://stackctl.dev                                                                            |

Where each one lives:

| Place                                  | Headline                          | Description                                      | Homepage   |
| -------------------------------------- | --------------------------------- | ------------------------------------------------ | ---------- |
| `README.md`                            | the line under the title          | the intro's first sentence (`stackctl is a …`)   | the docs link |
| `docs/index.md` (the site's home page) | `hero.text`                       | `hero.tagline`                                   |            |
| `docs/.vitepress/config.ts`            |                                   | `description` (search results, `<meta>`, `llms.txt`) | `sitemap.hostname` |
| `packages/stackctl/package.json`       |                                   | `description` (the npm page)                     | `homepage` |
| `packages/stackctl/src/cli.ts`         |                                   | the program's `.description(…)` (`stackctl --help`) |         |
| The GitHub repo (`rhyek/stackctl`)     |                                   | About → description                              | About → website |

- **The GitHub repo's settings aren't in the tree.** Check and set them with `gh`:

  ```sh
  gh repo view rhyek/stackctl --json description,homepageUrl
  gh repo edit rhyek/stackctl --description "<description>" --homepage https://stackctl.dev
  ```

  Changing them is visible to everyone at once, so do it as part of the change that changes the
  wording, and say so.
- **`stackctl --help` needs a build** to show a new description (`pnpm build`); the source change
  is enough for the change itself.
- **Check before calling it done:** grep the places above for the old wording and the new, and
  every copy reads the same, punctuation included.
- **Released `CHANGELOG.md` entries keep the wording they shipped with.** They are history, not
  a copy of the description.
- **Update this file's table** when the wording changes, so it stays the reference.
