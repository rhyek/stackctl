# Releasing

A release is a pull request whose `CHANGELOG.md` has a new version heading at the top. Merging
it publishes that version to npm and creates the `vX.Y.Z` GitHub release. A pull request with no
new heading (a docs fix, a refactor) merges without releasing anything.

Publishing uses npm **trusted publishing** (OIDC): no npm token is stored anywhere, and
[provenance](https://docs.npmjs.com/generating-provenance-statements) is attached automatically.

## Cutting a release

1. In the feature branch, add the change's entry under a new heading at the **top** of
   `CHANGELOG.md`. Each entry is one sentence with a bold summary, grouped under
   `### Features` / `### Fixes` / `### Breaking changes` once there are more than a few:

   ```md
   ## 0.2.0

   ### Features

   - **What changed.** See [docs/reference/cli.md](docs/reference/cli.md).

   ### Fixes

   - **What no longer breaks.**
   ```

   A prerelease heading (`## 1.0.0-beta.1`) is published under the npm dist-tag named by its
   label, `beta`, and marked as a prerelease on GitHub, so `npm install stackctl` keeps
   resolving to the latest stable version. A stable version goes to `latest`.

2. Open the pull request. CI's `check` job runs `node maintenance/scripts/changelog.ts check`,
   which fails if the top section is empty, its version isn't newer than the latest release, or it adds
   an entry to a version already released (rewording one, or fixing its link, is fine). A
   new entry always goes under a new heading. It also fails if any link in `CHANGELOG.md`
   points at a file or heading that doesn't exist, as one does after a page moves.

3. Merge it. `.github/workflows/release.yaml` reads the top heading and, if that version
   isn't out yet, runs CI again on the merged result, then:
   - publishes the package to npm, tokenless over OIDC;
   - creates the GitHub release and its `vX.Y.Z` tag, with the section as its notes and its
     relative links pinned to the tag.

   Each half runs only if it's missing, so if one fails, re-run the workflow (Actions →
   release → Run workflow, on `main`) and it finishes the other.

`main` takes changes only through pull requests, with CI's `check` passing:
[`.github/rulesets/main.json`](.github/rulesets/main.json) is the repository ruleset that
enforces it.

## One-time setup

Do these in order: the first push to `main` runs the release workflow, which can't publish
until the package exists on npm and trusts it.

1. **Publish the first version by hand.** npm won't let you configure a trusted publisher
   until the package exists.

   ```sh
   pnpm build
   cp LICENSE packages/stackctl/LICENSE
   cp README.md packages/stackctl/README.md
   # pin the README's images to the release's tag, as release.yaml does
   sed -i '' 's#/rhyek/stackctl/main/#/rhyek/stackctl/v<first-version>/#g' packages/stackctl/README.md
   cd packages/stackctl
   npm version <first-version> --no-git-tag-version   # temporary, do not commit
   npm login                                          # if not already logged in
   npm publish --access public --tag <dist-tag>       # `latest` for a stable version,
                                                      # `beta` for 1.0.0-beta.1
   npm version 0.0.0 --no-git-tag-version             # back to the repo's 0.0.0
   cd ../..
   ```

2. **Configure the trusted publisher** on npmjs.com → the package → **Settings → Trusted
   Publisher → GitHub Actions**:
   - Organization or user: `rhyek`
   - Repository: `stackctl`
   - Workflow filename: `release.yaml`
   - Environment: `release`

3. **Push the initial commit to `main`.** The release workflow sees the version is already
   on npm and creates only its GitHub release.

4. **Make `main` pull-request only** by creating the ruleset (it can't exist before `main`
   does, since a pull request needs a branch to merge into):

   ```sh
   gh api repos/rhyek/stackctl/rulesets --method POST --input .github/rulesets/main.json
   ```

5. **Limit the `release` environment to `main`** (Settings → Environments → `release` →
   Deployment branches and tags → Selected branches → `main`). The environment appears after
   the workflow's first run.
6. **Delete a pull request's branch when it merges:**

   ```sh
   gh api repos/rhyek/stackctl --method PATCH -F delete_branch_on_merge=true
   ```
