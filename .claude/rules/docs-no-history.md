---
paths:
  - "README.md"
  - "docs/index.md"
  - "docs/guide/*.md"
  - "docs/config/*.md"
  - "docs/reference/*.md"
  - "docs/ai/*.md"
  - "packages/stackctl/assets/skill.md"
---

# User-facing docs — the current surface only, no history

**Describe what stackctl does today, and nothing about what it did before.** This covers
`README.md`, the site's pages in `docs/` (`guide/`, `config/`, `reference/`, `ai/`) and the
installed skill, `packages/stackctl/assets/skill.md`. An agent reads these pages to use
stackctl, so history costs it tokens each time, and a reader who never saw the old behavior can
only be confused by a description of it.

The test for every sentence: **would it make sense to a reader who has never seen an earlier
stackctl?** If it only makes sense next to removed or changed behavior, cut it.

- **No before/after.** No "now", "no longer", "used to", "previously", "renamed from", "instead
  of the old …" — state the behavior as a plain fact.
- **No version gates.** No "since 0.7.0", "older than X.Y", "as of this release". The docs
  ship with the version they describe.
- **No ghosts of removed features.** Don't deny a field, flag, or syntax that only existed in
  an earlier version. A denial is fine when it heads off a mistake a reader would make from
  general habit (`there is no enabled flag; remove the block`).
- **No reassurance left over from a fix.** "So X never loses its color", "you don't have to Y
  to keep Z" — say what happens, not which bug it rules out.
- **Rationale is fine, history is not.** Why a design is the way it is, or what happens
  without an option set, describes the current surface and can stay.

The story of a change belongs in the commit message and `CHANGELOG.md`.

Wrong:

> `startedByAgent` — whether a coding agent started this session. Omitted by instances older
> than 0.7.0, which reads as `false`.

Right:

> `startedByAgent` — whether a coding agent started this session.

Wrong:

> **There is no `$port`/`$name` interpolation** — a `$` in a config string is a literal `$`.

Right:

> **stackctl does no string interpolation** — a `$` in a config string is a literal `$`.
