---
paths:
  - "README.md"
  - "docs/index.md"
  - "docs/.vitepress/config.ts"
  - "packages/stackctl/package.json"
  - "packages/stackctl/src/cli.ts"
  - "docs/public/logo.svg"
  - "docs/public/logo-small.svg"
---

# How stackctl describes itself — one wording and one icon, everywhere, in lockstep

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

## The icon

`docs/public/logo.svg` is the icon: a prompt in front of three log lines, the middle one yellow,
on a dark rounded tile. `docs/public/logo-small.svg` is the same icon for small sizes, with the
three lines as thick as the prompt's stroke. Everything else is made from one of the two, so a
change to the icon is a change to both and to all of these, in the same change:

| Place                                   | File                               | Wired in                                   |
| --------------------------------------- | ---------------------------------- | ------------------------------------------ |
| The browser tab                         | `logo-small.svg`, and `favicon-32.png` | `head` in `docs/.vitepress/config.ts`  |
| An iPhone's home screen                 | `apple-touch-icon.png` (180 px, square: iOS rounds it) | `head`                 |
| The site's nav bar                      | `logo-small.svg`                   | `themeConfig.logo`                         |
| The home page, beside the headline      | `logo.svg`                         | `hero.image` in `docs/index.md`            |
| A link's preview (Slack, X, …)          | `og-image.png` (512 px, square corners: Slack rounds it) | `og:image` in `head`   |

- **The PNGs are renders of the SVGs.** Re-render all three when either changes, at their sizes,
  from a browser (headless Chrome with a transparent background): `favicon-32.png` from
  `logo-small.svg`; the touch icon and the preview from `logo.svg` with the tile's corners
  squared.
- **Every URL to them carries a hash of the file** (`versioned()` in the site config), so a
  changed icon is a new URL and no browser or CDN keeps the old one. Reference a public file
  through it, never by its bare path.
