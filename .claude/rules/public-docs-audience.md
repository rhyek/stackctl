---
paths:
  - "CHANGELOG.md"
  - "README.md"
  - "docs/**"
  - "packages/stackctl/skills/stackctl/SKILL.md"
  - "packages/stackctl/assets/agent-rules.md"
---

# Changelog and public docs — written for the people who use stackctl

**Every entry and every sentence is for a software developer who runs their project's services
with stackctl, and for the coding agent working beside them.** That developer works in any
language and any stack: a Go or Rust service runs under stackctl as well as a Node one, and
`stackctl.config.ts` may be the only TypeScript they touch. Never add an item that only a
maintainer of stackctl would care about.

This covers `CHANGELOG.md`, `README.md`, everything under `docs/` (the site, which `llms.txt`
and the package's copy are built from) and what stackctl installs for agents,
`packages/stackctl/skills/stackctl/SKILL.md` and `packages/stackctl/assets/agent-rules.md`.
Maintainers' notes, including the contributor internals and Superpowers' specs and plans, live in
`maintenance/docs/`, which this rule does not cover.

## Only what a user acts on

The test: **would someone using stackctl act on it, or need it to use stackctl?** If not, it
stays out.

Out, however much work it was:

- Refactors, moved or merged files, deleted internal code, renamed internals.
- The unit, type and end-to-end tests, CI, lint and format config, release tooling.
- The docs site's tooling, the terminal recordings and how they are made, the agent eval.
- Dependency bumps that change nothing a user sees.
- A bug that never shipped in a release on npm.

In, however technical it looks:

- Anything that breaks a user's `stackctl.config.ts`, scripts, CI or agent setup, with what to do
  about it.
- New capabilities, config options, CLI commands and flags, control API endpoints and SDK
  exports; changed defaults; what the terminal UI shows and which keys it takes.
- What stackctl installs or offers to install in a user's repo: the skill, the rules file, the
  `AGENTS.md` block.
- Supported versions of Node.js and TypeScript.
- Fixes to behavior a released version had.
- Performance a user feels: startup time, memory, how the terminal UI keeps up with logs.

## The docs describe stackctl as it is now

Every doc but `CHANGELOG.md` describes the current stackctl only, never its past behavior,
options or names: [`docs-no-history.md`](docs-no-history.md) has the rule. History belongs in
`CHANGELOG.md` and in commit messages.

## The changelog

Released versions are on npm (`npm view stackctl versions`); the `v<version>` git tag is the
commit each was published from. A version not on npm is unreleased, and its changelog section
describes the difference from the latest released one, not the work in between: a bug introduced
and fixed inside it gets no entry, and an entry for something it changed again is rewritten to
the final behavior.
