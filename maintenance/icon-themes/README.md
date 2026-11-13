# stackctl's icon in VS Code's icon themes

`stackctl.config.*` files show the stackctl icon in VS Code once an icon theme carries it. These
are the files for the two themes most people use, ready to add to each one's repository by pull
request. Nothing here ships with the package or the site.

| Theme | Its repository | Files |
| --- | --- | --- |
| Material Icon Theme | [material-extensions/vscode-material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) | `material-icon-theme/stackctl.svg`, `stackctl_light.svg` |
| vscode-icons | [vscode-icons/vscode-icons](https://github.com/vscode-icons/vscode-icons) | `vscode-icons/file_type_stackctl.svg` |

`node maintenance/scripts/icon-themes.ts` writes them from `docs/public/logo-small.svg`, so run it
whenever that changes and commit both together. The script's header says how each theme's
version differs.

## Material Icon Theme

The SVGs go in `icons/`, and this entry at the end of the list in `src/core/icons/fileIcons.ts`:

```ts
{
  name: 'stackctl',
  fileNames: [
    'stackctl.config.ts',
    'stackctl.config.mts',
    'stackctl.config.js',
    'stackctl.config.mjs',
  ],
  light: true,
},
```

- **Colors come from the Material palette only:** `npm run check-colors` (CI runs it).
- **`npm run check`** catches a file name another icon already claims.
- **The pull request's title is a conventional commit:** `feat: add stackctl icon`.

## vscode-icons

The SVG goes in `icons/`, and this entry in `src/iconsManifest/supportedExtensions.ts`, after
`stackblitz` (the list is alphabetical):

```ts
{
  icon: 'stackctl',
  filenamesGlob: ['stackctl.config'],
  extensionsGlob: ['ts', 'mts', 'js', 'mjs'],
  filename: true,
},
```

- **The SVG is linted:** `npm run lint:svg` wants a `0 0 32 32` viewBox, no comments and at most
  3 decimals; `npm run optimize-icon` runs their SVGO over it.
- **`npm test`** checks the entry against the SVG.
- **Open an icon request issue first**, with the SVG attached, and reference it from the pull
  request (`Fixes #…`); its title is `feat(icon): add stackctl icon`.
