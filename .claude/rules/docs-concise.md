---
paths:
  - "README.md"
  - "docs/index.md"
  - "docs/guide/*.md"
  - "docs/config/*.md"
  - "docs/reference/*.md"
  - "docs/ai/*.md"
---

# User-facing docs — only what a developer needs, where they will look for it

**A page documents what a developer needs to use the feature, and nothing they would never
miss.** A long page hides the facts that matter: someone scanning for when a hook runs should
not have to read past what happens when a process ignores `SIGTERM`.

## What stays, what goes

Keep what a developer must know to use the feature right:

- **What it is and how to write it**, led by an example.
- **When it runs and in what order.** For anything that runs at a point in time (hooks,
  callbacks, startup and shutdown steps), this is the page's core.
- **What it receives and returns.**
- **A default they would get wrong or have to look up**, even an intuitive one: where a command
  runs (`cwd`), which environment it gets.
- **What a failure does**, and how to recover.
- **A limit they will meet in normal use**: a timeout, a cap.

Cut, however true and however much work it was:

- **What they would assume anyway.** "Every hook is optional." "A hook runs around the step,
  not instead of it."
- **What an error already tells them.** A misspelled key, a wrong type, a value TypeScript
  rejects, a command that isn't installed: the compiler or the log says it at the moment it
  matters.
- **Edge cases they won't normally run into.** A process killed with `kill -9`, a command that
  daemonizes itself, two requests that arrive in the same instant, what happens on the 257th of
  something.
- **Esoteric mechanics.** Which signal is sent after how many seconds, what overlaps what for
  how long, how stackctl tracks a process. That belongs in `maintenance/docs/architecture/`.
- **The same fact twice on one page.**

The test for a sentence: **would a developer using this feature for a month ever need it, and
would they fail to work it out from the example, the types or the error?** If not, cut it.

## What only an agent needs: `<llm-only>`

Some detail is worth keeping for a coding agent, which reads a page whole and acts on it, but
would bury what a person scanning the page came for: what each hook's failure does, how to
recover a failed service, the time limits. Wrap it in `<llm-only>`:

```markdown
<llm-only>

## When a hook fails

…

</llm-only>
```

- **It is left out of the site** and kept in what agents read: the page's Markdown copy,
  `llms-full.txt` and the copies inside the npm package (`vitepress-plugin-llms` does both).
- **Leave a blank line after the opening tag and before the closing one**, so the Markdown
  inside is read as Markdown.
- **Its headings have no anchor on the site.** Another page links to the page, not to a heading
  inside the block.
- **Never for a fact a person needs to use the feature.** That stays on the site. And never as
  a place to keep what the first section says to cut: an edge case is cut for agents too.

## Easy to find, easy to follow

- **Never "the table above", "as described earlier" or "see below".** Put the fact beside what
  it explains, or link the section by name. A reader arrives from a search or a link, in the
  middle of the page.
- **Each table answers one question, and the sentence before it says which.** Two tables in a
  row with no line between them leave the reader guessing which one to read.
- **An option and what it is relative to go together.** `cwd` is explained next to the
  directory it resolves against, not three paragraphs later.
- **One sentence where a table's rows would all say the same thing.** A column of `yes` is a
  sentence.
- **Trim when you add.** A page that grew with a feature gets re-read whole before the change
  is done, and what the new text made redundant goes.
