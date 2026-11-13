# stackctl's icon

A prompt in front of three log lines, the middle one yellow, on a dark rounded tile.

| File | What it is | Used by |
| --- | --- | --- |
| `logo.svg` | The icon. | The site's home page; the source of the touch icon and the link preview. |
| `logo-small.svg` | The icon for small sizes: its three lines as thick as the prompt's stroke. | The site's browser tab and nav bar; the source of the favicon and the icon themes' files. |
| `site/favicon-32.png` | 32 px, from `logo-small.svg`. | The browser tab, where it can't take an SVG. |
| `site/apple-touch-icon.png` | 180 px, square, from `logo.svg`. | An iPhone's home-screen bookmark. |
| `site/og-image.png` | 512 px, square, from `logo.svg`. | A link's preview (Slack, X, …). |
| `icon-themes/vscode/<theme id>/` | `stackctl.config.*`'s file icon, from `logo-small.svg`. | VS Code's icon themes, by pull request: see [its README](icon-themes/README.md). |

The site serves its files through symlinks in `docs/public/`. How each file is made, and what a
change to the icon has to update, is in
[`.claude/rules/project-wording.md`](../.claude/rules/project-wording.md#the-icon).
