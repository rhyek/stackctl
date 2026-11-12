---
name: commit
description: >-
  Commit the work in the stackctl repo, re-recording first any of the docs' terminal recordings
  (scripts/demo: the home page demo, the README GIF, the guide pages' players and screenshots)
  that the changes would alter, so the recordings land in the same commit as the change that
  caused them.
  Use when the user asks to commit in this repo ("commit it", "/commit"), and whenever a
  `git commit` is blocked by the recordings hook. Never on your own initiative: a commit needs
  the user's word.
---

# Commit, with the recordings kept current

The docs show stackctl's terminal UI as recordings of the real thing (see
`scripts/demo/CLAUDE.md`). A change to what a screen shows makes its recording wrong. This skill
re-records what a change touches before committing, so the recording and the change travel
together.

A hook enforces it (`.claude/hooks/check-recordings.ts`, wired in `.claude/settings.json`): a
`git commit` whose changes match a scene's triggers is blocked unless the changes carry a new cast
for that scene, or the commit is prefixed with `STACKCTL_RECORDINGS_CHECKED=1`.

## 1. See what is being committed

```sh
git status --short
git diff HEAD --stat
```

Everything uncommitted goes in, unless the user said otherwise. If something looks unrelated or
unfinished, ask before including it.

## 2. List the recordings the changes may alter

```sh
node scripts/demo/affected.ts
```

It prints each scene (`scripts/demo/scenes.ts`, the index of every recording) whose `triggers`
match a changed file, with its description and the matched files. Nothing printed: skip to step 5.

## 3. Judge which really change

Triggers are broad on purpose. For each listed scene, read the matched files' diff and decide
whether the change can reach what that scene shows (its description says what that is):

- **Re-record** when the change alters anything the scene puts on screen: a label, a color, a
  footer row, a key hint, a log line's text, the picker, the example's services or output, the
  scene's own steps, or the recorder (`record.ts`).
- **Skip** when it can't: a comment, a rename the screen never shows, a code path the scene
  doesn't exercise, an edit to `scenes.ts` that only touches another scene or the index's
  descriptions.
- **Unsure: re-record.** A re-recording costs a minute; a stale one ships.

Say which scenes you re-record and which you skip, with the reason, in one line each. When you
skip a scene the hook listed, commit with `STACKCTL_RECORDINGS_CHECKED=1 git commit …`: that is
your statement that you judged it, so make the judgment first.

## 4. Re-record

```sh
./scripts/demo/record.sh <scene> [<scene>…]
```

About 30 seconds a scene. It needs Docker running and the example's ports (21060, 3001, 3002, 21050)
free. If a port is held, it names the process and stops: tell the user, never kill it. Build
first if `packages/stackctl` changed (`pnpm build`), since the example runs the built `dist/`.

Then check what it wrote:

- **The text copies:** `git diff docs/` shows each page's new text beside its player. Read it as
  the screen the change should produce. A difference you didn't expect means the change does more
  than intended, or the scene broke: stop and tell the user.
- **The demo's GIF** (only if `demo` was re-recorded): `node scripts/demo/frames.ts` must end in
  `OK`. Open a frame or two from `scripts/demo/.frames/` where the change shows.

## 5. Commit

- **Check the changelog first.** A change a stackctl user would notice needs an entry in
  `CHANGELOG.md` (see the repo's CLAUDE.md). If it is missing, say so and ask; don't commit
  without it, and don't write it unasked.
- **One commit**, the change and its recordings together. Follow the subjects in `git log`: an
  imperative sentence in plain words, no prefix. The body says what changed and why, wrapped at
  72 columns.
- **Don't push.** Report the commit and the recordings it carries.
