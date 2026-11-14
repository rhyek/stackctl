---
name: hotfix
description: >-
  Ship a small, finished fix in the stackctl repo end to end without stopping: branch, commit,
  push, pull request, CI, merge, deployment, and a check that the docs site or the npm package
  now serves the change. Only when the user invokes /hotfix.
disable-model-invocation: true
allowed-tools:
  - Bash(git *)
  - Bash(STACKCTL_RECORDINGS_CHECKED=1 git commit *)
  - Bash(gh *)
  - Bash(pnpm *)
  - Bash(node *)
  - Bash(npm view *)
  - Bash(curl *)
  - Bash(./maintenance/scripts/demo/record.sh *)
  - Read
  - Edit
  - Write
---

# Hotfix: ship a small change end to end

`/hotfix` is the user's word to commit, push, open the pull request **and merge it**. It covers
this one change, from start to finish. Don't ask for confirmation at any step, and don't stop
at "PR opened" or "merged": the job ends when the live site or npm serves the change, or when
something fails that you can't fix.

The repo's rules still apply in full: no AI attribution in the commit or PR body, the
recordings check before committing, no personal content, and docs and changelog style.

## 1. Settle what ships

```sh
git fetch -q origin
git status --short
git diff HEAD
```

- **The change is the working tree's uncommitted work.** If nothing is uncommitted, stop and
  say so.
- **Leave out anything plainly unrelated** to the fix. Don't stage it, and name it in the
  report.
- **Classify the change**, since it decides what step 7 verifies:
  - **docs:** it touches `docs/`, `logo/`, the root `package.json` or `pnpm-lock.yaml`, which
    trigger `docs.yaml`.
  - **package:** a stackctl user would notice it (`packages/stackctl/src`, `assets/`,
    `skills/`, its `package.json`). It needs a release: add a patch heading at the top of
    `CHANGELOG.md`, one above the latest `v*` tag (`git tag --sort=-v:refname | head -1`), with
    the entry in house style (the `clean-changelog-entry` skill's rules). A fix is
    `### Fixes`. If the top heading is still unreleased, add to it instead.
  - **neither:** tests, CI, maintenance scripts. There's nothing to deploy, and the merge still
    has to leave `release` green.
  - A change can be both docs and package.

## 2. Branch

Branch from `origin/main`. The uncommitted work comes with you:

```sh
git switch -c <type>/<kebab-summary> origin/main
```

`<type>` is `fix`, `docs`, `test`, `ci`, `chore` or `refactor`. The summary names the change in
two to five words: `docs/consistent-start-stack-example`, `fix/env-reload-on-symlink`.

## 3. Check locally

Run what CI would fail on for this kind of change, so CI doesn't fail first:

- **docs:** `pnpm docs:build` (dead links) and `pnpm lint`.
- **package:** `pnpm build`, `pnpm lint`, `pnpm test`, plus `pnpm test:types` if types changed
  and `pnpm test:e2e` if the TUI or CLI did.
- **changelog:** if you touched it, `node maintenance/scripts/changelog.ts check`.

Fix what fails and run it again.

## 4. Commit

Follow the `commit` skill's steps 2 to 4 (`node maintenance/scripts/demo/affected.ts`, judge
each scene, re-record or skip). Prefix the commit with `STACKCTL_RECORDINGS_CHECKED=1` only for
scenes you judged and skipped.

- **Subject:** an imperative sentence in plain words, no prefix, matching `git log`: `Make the
  startStack example start the service it calls`.
- **Body:** what changed and why, formal and wrapped at 72 columns.
- **No trailers.**

If the pre-commit hook rewrites files, stage them and commit again. Never `--no-verify`.

## 5. Pull request

```sh
git push -u origin HEAD
gh pr create --base main --title "<commit subject>" --body "<body>"
```

The body is a short summary, then a **Verification** list of what step 3 ran. No attribution
footer.

## 6. CI, then merge

```sh
gh pr checks <n> --watch --fail-fast
```

- **Green:** `gh pr merge <n> --merge --delete-branch`, the merge style `main` already uses.
- **Red from the change:** read the log (`gh run view <id> --log-failed`), fix it, commit and
  push, and watch again. After three failed rounds, stop and report, with the PR left open.
- **Red and not from the change** (a flaky test, a runner error): rerun it once
  (`gh run rerun <id> --failed`). If it fails again, stop and report.
- **Never** bypass the ruleset: no `--admin`, no disabling checks.

## 7. Deployments, then the live check

Take the merge commit (`gh pr view <n> --json mergeCommit -q .mergeCommit.oid`) and find its
runs. They can take a few seconds to show up:

```sh
gh run list --commit <sha> --json databaseId,workflowName,status,conclusion
gh run watch <id> --exit-status
```

Watch `release`, which runs on every merge, and `docs` when it ran. A run longer than the
command timeout goes in the background. A failed deploy run gets one rerun, then you stop and
report.

Then confirm what users get. A green run is not enough:

- **docs:** fetch each changed page with a cache-busting query and find a phrase only the new
  version has: `curl -s "https://stackctl.dev/<page path without .md>?v=<sha>" | grep -F
  '<phrase>'`. The page's Markdown copy is at the same path plus `.md`. GitHub Pages can take
  a minute or two to serve a deploy, so retry for up to five minutes before calling it failed.
- **package:** `npm view stackctl version` prints the new version,
  `gh release view v<version>` exists, and `npm view stackctl@<version> dist.attestations`
  shows provenance.
- **neither:** `release` finished green and published nothing.

## 8. Clean up and report

```sh
git switch main && git pull --ff-only -q && git branch -d <branch>
```

Report in a few lines: the PR link, the merge commit, each run and how it ended, and the live
check's result (the URL and phrase, or the npm version). Say what you left out in step 1, any
CI round you had to fix, and any step that failed.
