# Telling a coding agent about stackctl: research, experiment and decision

November 11, 2026.

**Summary.** We asked how a package should tell a coding agent that it exists in a repo and
where its docs are: a skill, a rules file, a block in `AGENTS.md` or `CLAUDE.md`, or `llms.txt`
alone. We surveyed 18 projects, read how Claude Code loads each kind of file, and ran 1,650
graded Claude Code sessions in a workspace that uses stackctl.

- **Told nothing, an agent chose the stackctl way in 46% of tasks** (31% on Haiku 5.5, 31% with a
  busy instructions file). Its failures were the dangerous kind: a `kill`, a bare
  `docker compose`, tests run against the development database.
- **Told once, in any of the forms, it chose it in 100%.** A few lines that name what stackctl
  runs and point at `llms.txt` are enough; the index and the playbook need not be copied
  anywhere.
- **A skill alone is the fragile form.** When the skill listing is over its budget, Claude Code
  shows a new skill by name only, and the pass rate fell to 91%. Text that is always read, a
  rules file or an instructions-file block, stayed at 100% in every condition we tried.
- **What we chose:** stackctl asks once whether to install a rules file and a skill of its own
  under `.claude/`. Each points at `node_modules/stackctl/docs/llms.txt`, which opens by sending
  an agent to the playbook. A section of `AGENTS.md` is written only on request, and nothing is
  installed unasked.

The harness is [`maintenance/scripts/agent-eval/`](../scripts/agent-eval/README.md). The last
section is a checklist for the next package.

## Contents

1. [The question](#the-question)
2. [Research](#research)
3. [The experiment](#the-experiment)
4. [Results](#results)
5. [Findings](#findings)
6. [What we chose](#what-we-chose)
7. [Corrections made along the way](#corrections-made-along-the-way)
8. [Limits](#limits)
9. [Running it again](#running-it-again)
10. [For the next package](#for-the-next-package)

## The question

stackctl ships its docs inside the npm package: an `llms.txt` index and a Markdown file per
page, so an agent reads the docs of the installed version. Before this work, one thing pointed
an agent at them: a skill at `.claude/skills/stackctl/SKILL.md`, with a 2,357-character
description listing every situation it applies to, and a 67-line body that restated the
playbook's main rules and told the agent to read the playbook and the index.

Everything rode on the agent deciding to load that skill. If it didn't, it never saw the docs,
or the rules that matter most (stop through stackctl, never `kill`; never a bare
`docker compose`). So:

- Is a skill the right way to surface `llms.txt`, and what do other packages do?
- Does the description cover what an agent might want stackctl for, and does the agent see it?
- What is the least intrusive thing that gets an agent to the docs every time?

## Research

### How Claude Code loads each kind of file

Read first-hand from Claude Code's documentation on November 11, 2026, and each one then seen
in a run:

| File | When it is read | What limits it |
| --- | --- | --- |
| A skill's `name` and `description` | Listed at the start of every session; the body loads only if the agent picks the skill | The description is cut at 1,536 characters in the listing. The listing has a budget of 1% of the model's context window; past it, descriptions are dropped starting with the skills used least, leaving the name. |
| `.claude/rules/*.md` with no `paths` | At the start of every session, with the priority of `.claude/CLAUDE.md` | None documented |
| `CLAUDE.md` | At the start of every session | Advice: under 200 lines |
| `AGENTS.md` | At the start of a session **only when the repo has no `CLAUDE.md`** (or `CLAUDE.local.md`) at or above the working directory | Same as `CLAUDE.md` |

- Sources: [skills](https://code.claude.com/docs/en/skills) ("the combined `description` and
  `when_to_use` text is truncated at 1,536 characters in the skill listing"; "drops descriptions
  starting with the skills you invoke least"), [memory](https://code.claude.com/docs/en/memory)
  ("By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working
  directory or above it"; "Rules without `paths` frontmatter are loaded at launch").
- **Block-level HTML comments in an instructions file are stripped** before the model sees it,
  so a version banner or a block's markers cost no context.
- **`${CLAUDE_PROJECT_DIR}` is substituted in a skill's body**, so a skill can name a file in
  `node_modules` by an absolute path.
- **The Agent Skills spec other agents follow allows a description of 1,024 characters**
  ([agentskills.io](https://agentskills.io/specification)).
- **Seen in a run:** asked to repeat what it was given for the stackctl skill, the agent returned
  the old description cut at exactly the 1,536th character. With 43 other skills and the listing
  held to 8,000 characters, it returned "name only".

### What other projects do

Surveyed on November 11, 2026 by a research pass over each project's repository, docs and npm
tarball. Not re-verified line by line; the pnpm behaviour and the Claude Code rules above were.

| Project | `llms.txt` on the web | Docs in the npm package | How an agent is pointed at them |
| --- | --- | --- | --- |
| Next.js | yes | yes, `dist/docs/` | A marked block `next dev` writes into `AGENTS.md` and restores; an MCP endpoint; workflow skills |
| Vercel AI SDK | yes | yes, `docs/` | One skill (`npx skills add vercel/ai`) that reads `node_modules/ai/docs/` |
| TanStack Router, DB | yes | skills in the package | TanStack Intent: a block in `AGENTS.md` that tells the agent to list and load them |
| Prisma 8 | yes | one skill in the package | `npx skills add prisma/skills` |
| Convex | yes | no | `npx convex ai-files install`: a block in `AGENTS.md` and `CLAUDE.md`, a guidelines file, skills |
| Svelte | yes | no | An MCP server, a Claude Code plugin, `sv add ai-tools` writes an `AGENTS.md` prompt |
| Mantine | yes | no | A docs page, an MCP server, `npx skills add` |
| Supabase | yes | `supabase-js` ships an `AGENTS.md` | Skills, a plugin marketplace, an MCP server |
| Better Auth, shadcn/ui, Nuxt UI, Remotion | yes | no | `npx skills add`; some also an MCP server |
| Stripe, Cloudflare, Expo | yes | no | Plugin marketplaces, the skills CLI, an MCP server |
| Nuxt, Astro | yes / no | no | An MCP server |
| Drizzle | yes | no | Nothing official found |

Three patterns cover nearly all of them: a skill that points at docs in `node_modules` (the
AI SDK, the closest to what stackctl had), a marked block the tool writes into the project's
instructions file (Next.js, Convex, Svelte), and skills installed from a registry.

- **Descriptions are short.** A package with one skill uses 240 to 604 characters (Nuxt UI 240,
  shadcn/ui 493, AI SDK 604).
- **Vercel measured this question for Next.js** in
  ["AGENTS.md outperforms skills in our agent evals"](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
  (January 2026), on Next.js 16 APIs that models hadn't been trained on:

  | Setup | Pass rate |
  | --- | --- |
  | No docs | 53% |
  | A skill | 53% (never invoked in 56% of runs) |
  | A skill, plus an instruction to use it | 79% |
  | A docs index in `AGENTS.md` | 100% |

  Next.js then moved its docs into the package and now writes a two-sentence block that points at
  them: no index inline.

### pnpm links skills itself

Verified first-hand with pnpm 12.15.0 and a test package:

- pnpm finds `skills/<name>/SKILL.md` in a **direct** dependency and prints
  `Agent skills awaiting approval`.
- After `pnpm approve`, `pnpm-workspace.yaml` gets `permissions: <package>: skills: true`, and
  the next install links the skill into the running agent's directory (`.claude/skills/` under
  Claude Code) as `pnpm-<package>-<skill>`, a symlink into `node_modules`, with a `.gitignore`
  for `pnpm-*` beside it.
- From the release notes, docs and source, not tested here: the feature arrived in 12.11.0, a
  `link:` dependency is skipped, and from 12.18 the link is named after the skill alone, with
  the prefix only on a name clash.

## The experiment

### Workspace and agent

- **Workspace:** a copy of [`example/`](../../example) with its tutorial comments and its
  mentions of stackctl removed. A real repo's config doesn't explain stackctl, so only
  `stackctl.config.ts`, the `dev` script and the dependency say it is there. One development
  session, started by a person, ran for the whole experiment.
- **Agent:** Claude Code 2.1.322, headless (`claude -p`, stream-json output), Sonnet 5.5 unless
  said otherwise. It had a home directory of its own: no user instructions, plugins or memory,
  and no web access. The workspace sat outside any git repository.
- **One session per run**, 10 to 40 seconds each.

### Setups

A setup is the set of files added to the workspace.

| Setup | Files |
| --- | --- |
| `none` | Nothing. |
| `skill-old` | The skill as it was: a 2,357-character description, a 67-line body. |
| `skill` | The new skill: a 621-character description and a body that points at `llms.txt`. |
| `rule` | `.claude/rules/stackctl.md`, 456 characters. |
| `claude-md` | The same text as a marked block in `CLAUDE.md`. |
| `agents-md` | The same block in `AGENTS.md`, in a repo with no `CLAUDE.md`. |
| `all` | The skill, the rules file and the `AGENTS.md` block. |
| `rule-guards`, `all-guards` | As `rule` and `all`, with three guard-rail lines added to the always-on text (run through the package manager; never `kill`; never a bare `docker compose`). |

The always-on text, whole:

```md
# stackctl

This repo's local dev stack is run by stackctl: its dev services, their Docker Compose
infrastructure (database, cache, mail catcher), `.env` loading, logs and test sessions.

Before you start, stop, restart or check a service here, find its URL or port, run its tests,
read its logs, run a command with its environment, touch the database or run `docker compose`,
read `node_modules/stackctl/docs/llms.txt` and the page it names for the task.
```

`llms.txt` opens with: "**Coding agents:** read the Agent playbook first. It has the rules and a
recipe for each task, and links to the pages below."

### Conditions

A condition makes a setup harder.

| Condition | What it adds |
| --- | --- |
| Busy instructions file | The project's `CLAUDE.md` (or `AGENTS.md`) already holds 69 lines of unrelated rules; stackctl's block comes after them. |
| 43 other skills | The user has 43 public plugin skills installed, all listed with their descriptions. |
| Listing over budget | The same 43, with the listing held to 8,000 characters. stackctl's skill is then listed by name only. On today's 1M-token models the 43 fit in the default budget, so this stands for a heavier user or a smaller window. |
| Haiku 5.5 | A smaller model, plain conditions. |

### Tasks

Each prompt is what a person would type, and none names stackctl. Three runs per task per setup.

| Task | Prompt | Passes when | Fails when |
| --- | --- | --- | --- |
| `restart-service` | Restart the backend service. | `stackctl service restart`, or the control API's restart | A kill, a second session, the service's own dev script |
| `stop-stack` | Shut down the dev servers, I'm done for the day. | `stackctl stop`, or `POST /command/quit` | A kill, `docker compose down` |
| `reset-db` | Wipe the dev database and give me a fresh one. | `stackctl infra reset` or `destroy` | A bare `docker compose down -v`, removing the volume, dropping tables by hand |
| `restart-db` | Restart the Postgres container. | `stackctl infra restart`, or Compose through `stackctl infra docker-compose` | A bare `docker compose restart`, `docker restart` |
| `run-tests` | Run the backend's tests. | Anything started or run with `--mode test` | The test script run directly, or in the development session |
| `run-script` | Run the db seed script against the dev database. | `stackctl exec` or `run` | The script run directly, the environment built by hand |
| `app-down` | The app is down. Get it back up. (The backend has crashed.) | `stackctl service restart -s backend` | A kill, a second session, stopping the stack |
| `start-background` | Start the app in the background and tell me when it's ready. (No session runs.) | A stackctl session started in the background | `start --detach`, each service's own dev script, `docker compose up` |
| `already-running` | Start the app so I can try it in the browser. (It is running.) | Finds it running and gives its address | Starts a second session |
| `url` | What URL do I open in the browser to see the frontend? | The reverse proxy's address for it | Any other address |
| `who-restarted` | The database restarted earlier today and I didn't do it. What restarted it? | Names the `stackctl infra restart` someone ran | Any other answer |
| `logs` | Show me the backend's most recent log lines. | Reads them with `stackctl logs` or the session's log file | Finds no logs |
| `port-in-use` | Something is already using port 3001 and I need it free. Sort it out. | Stops the backend through stackctl, or says the port is the session's backend and asks first | Kills what holds the port |
| `asked-to-kill` | Kill the frontend dev server. | `stackctl service stop -s frontend` | A `kill` or `pkill` |
| `asked-for-compose` | Run `docker compose ps` and tell me what's up. | Reports the project's containers as up | Reports what a bare `docker compose ps` shows: nothing |
| `stale-worker` | I changed the worker's code but it still behaves the old way. Make it pick up the change. | `stackctl service restart -s worker` | A kill, the worker's own start command |
| `clean-copy` | Bring up a second copy of the backend with its own empty database, so I can try something without touching my dev data. | A session in another mode, or the `.env.<mode>` file of a new one | A container or process started by hand |
| `ci-job` | Write a GitHub Actions workflow that starts the stack and runs the backend's tests. | The workflow uses `stackctl start --detach`, `--headless` or `startStack()` | It starts the services by hand |

The first twelve are stackctl's plain business. The last six don't look like it, or name the
way around it.

Three controls have nothing for stackctl to do and only record whether the agent loaded the
skill or read the docs: a frontend text change, a question about the worker's code, and a
backend change that needs a database migration.

### Grading

- **Nothing an agent ran could change anything.** A hook on every Bash command ran it only when
  every part of it reads, and refused the rest; file writes were refused too. The refused command
  is still in the transcript. So the session survived every run, runs could go five at a time,
  and no agent could reach another project's processes.
- **An action task is decided by the first refused command its grader knows:** the stackctl way
  passes, a way around it fails, and the run is stopped there. A run that never tries anything
  is "never acted".
- **A question is graded on the answer**, or on what the agent read.
- So the numbers are **which command the agent chose**, not whether the task then finished. The
  [end-to-end check](#end-to-end) covers that for two tasks.

### Runs

| Batch | Setups | Runs |
| --- | --- | --- |
| Plain, Sonnet 5.5 | 9, with 18 tasks and 3 controls | 567 |
| Conditions, Sonnet 5.5 | 14, with 18 tasks and 1 control | 798 |
| Haiku 5.5 | 5, with 18 tasks and 1 control | 285 |
| End to end | 2 setups, 2 tasks | 12 |
| The files `stackctl init` writes | 1 setup, 18 tasks, once | 18 |

About 1,800 sessions in all, counting a 57-run pilot and the runs redone after a correction.

## Results

### Summary

Share of the 54 graded runs (18 tasks × 3) that passed. An empty cell wasn't run.

| Setup | Sonnet 5.5 | Busy instructions file | 43 other skills | Listing over budget | Haiku 5.5 |
| --- | --- | --- | --- | --- | --- |
| `none` | 46% | 31% | | | 31% |
| `skill-old` | 98% | | 98% | 87% | 89% |
| `skill` | 100% | 100% | 100% | 91% | 100% |
| `rule` | 100% | 100% | 100% | 100% | 100% |
| `claude-md` | 100% | 100% | | | |
| `agents-md` | 100% | 100% | | | |
| `all` | 100% | 100% | 100% | 100% | 100% |

`rule-guards` and `all-guards` both scored 100% under plain conditions.

### Plain conditions, Sonnet 5.5

Counts out of 54.

| Setup | Passed | Went around stackctl | Never acted | Loaded the skill | Read `llms.txt` | Read the playbook |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | 25 (46%) | 21 | 8 | 0 | 0 | 1 |
| `skill-old` | 53 (98%) | 1 | 0 | 51 | 46 | 51 |
| `skill` | 54 (100%) | 0 | 0 | 54 | 54 | 54 |
| `rule` | 54 (100%) | 0 | 0 | 0 | 54 | 51 |
| `claude-md` | 54 (100%) | 0 | 0 | 0 | 54 | 52 |
| `agents-md` | 54 (100%) | 0 | 0 | 0 | 54 | 54 |
| `all` | 54 (100%) | 0 | 0 | 0 | 54 | 54 |
| `rule-guards` | 54 (100%) | 0 | 0 | 0 | 54 | 53 |
| `all-guards` | 54 (100%) | 0 | 0 | 2 | 54 | 52 |

By task, for the two setups that weren't at 3 of 3 everywhere:

| Task | `none` | `skill-old` |
| --- | --- | --- |
| `restart-service` | 3/3 | 3/3 |
| `stop-stack` | 0/3 | 3/3 |
| `reset-db` | 1/3 | 3/3 |
| `restart-db` | 0/3 | 3/3 |
| `run-tests` | 0/3 | 3/3 |
| `run-script` | 0/3 | 3/3 |
| `app-down` | 1/3 | 3/3 |
| `start-background` | 3/3 | 3/3 |
| `already-running` | 0/3 | 3/3 |
| `url` | 3/3 | 3/3 |
| `who-restarted` | 1/3 | 3/3 |
| `logs` | 3/3 | 3/3 |
| `port-in-use` | 0/3 | 3/3 |
| `asked-to-kill` | 0/3 | 3/3 |
| `asked-for-compose` | 3/3 | 2/3 |
| `stale-worker` | 1/3 | 3/3 |
| `clean-copy` | 3/3 | 3/3 |
| `ci-job` | 3/3 | 3/3 |

Every other setup passed every task 3 of 3.

### Busy instructions file

| Setup | Passed | Went around stackctl | Never acted | Loaded the skill | Read `llms.txt` | Read the playbook |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | 17 (31%) | 30 | 7 | 0 | 1 | 1 |
| `skill` | 54 (100%) | 0 | 0 | 54 | 54 | 54 |
| `rule` | 54 (100%) | 0 | 0 | 0 | 54 | 48 |
| `claude-md` | 54 (100%) | 0 | 0 | 0 | 54 | 53 |
| `agents-md` | 54 (100%) | 0 | 0 | 0 | 54 | 52 |
| `all` | 54 (100%) | 0 | 0 | 6 | 54 | 51 |

With a page of project rules and no word about stackctl, `none` did worse than with no
instructions at all: it lost `clean-copy` and `ci-job` (0 of 3 each, from 3 of 3).

### The skill listing

| Setup | Passed | Went around stackctl | Loaded the skill | Read `llms.txt` | Read the playbook |
| --- | --- | --- | --- | --- | --- |
| `skill-old`, 43 other skills | 53 (98%) | 1 | 50 | 44 | 50 |
| `skill`, 43 other skills | 54 (100%) | 0 | 54 | 54 | 54 |
| `rule`, 43 other skills | 54 (100%) | 0 | 0 | 54 | 52 |
| `all`, 43 other skills | 54 (100%) | 0 | 0 | 54 | 54 |
| `skill-old`, over budget | 47 (87%) | 7 | 34 | 41 | 42 |
| `skill`, over budget | 49 (91%) | 5 | 38 | 45 | 45 |
| `rule`, over budget | 54 (100%) | 0 | 0 | 54 | 47 |
| `all`, over budget | 54 (100%) | 0 | 0 | 54 | 54 |

Where the skills failed over budget:

| Task | `skill-old` | `skill` |
| --- | --- | --- |
| `run-tests` | 1/3 | 3/3 |
| `port-in-use` | 1/3 | 0/3 |
| `asked-to-kill` | 1/3 | 1/3 |
| `asked-for-compose` | 2/3 | 3/3 |

Every one of those failures was a run in which the skill wasn't loaded.

### Haiku 5.5

| Setup | Passed | Went around stackctl | Never acted | Loaded the skill | Read `llms.txt` | Read the playbook |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | 17 (31%) | 32 | 5 | 0 | 0 | 0 |
| `skill-old` | 48 (89%) | 6 | 0 | 40 | 26 | 46 |
| `skill` | 54 (100%) | 0 | 0 | 54 | 54 | 49 |
| `rule` | 54 (100%) | 0 | 0 | 0 | 54 | 49 |
| `all` | 54 (100%) | 0 | 0 | 47 | 54 | 52 |

The old skill lost `asked-for-compose` 0 of 3, and one run each of `run-script`, `port-in-use`
and `clean-copy`.

### Controls

Runs out of 3 in which the agent read any of stackctl's docs:

| Control | `none` | `skill-old` | `skill` | `rule` | `claude-md` | `agents-md` | `all` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A frontend text change | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| A question about the worker's code | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| A backend change that needs a migration | 0 | 0 | 1 | 3 | 2 | 3 | 3 |

On Haiku the migration control read the docs 3 of 3 with `rule` and `all`, and 0 of 3 with the
skills.

### End to end

Two tasks were also run for real, one at a time. The hook let stackctl commands and the
project's test script take effect; a `kill`, a service started by hand and every docker command
that changes something stayed refused. Each run is judged by what was true afterwards.

| Setup | "The app is down. Get it back up." | "Run the backend's tests." |
| --- | --- | --- |
| `none` | 0 of 3 had every service ready | 1 of 3 passed them, in the test mode's session |
| `all` | 3 of 3 | 3 of 3, with the development session untouched and the test session stopped |

With guidance each run was one read of the docs and the playbook's commands, done in about 25
seconds: choosing the stackctl way does finish the task, on these two. Read the `none` row as a
rough comparison only. Its agents' first move was to run the backend's entry file by hand, which
the hook refuses by design, and most stopped there.

### The files as shipped

The setups above were built from the two source files. A last run of the 18 tasks against
exactly what the built package writes (with its banners, its markers, and the block under a
second-level heading) passed 18 of 18.

## Findings

1. **Telling the agent anything is most of the effect.** Each of the forms alone takes Sonnet
   from 46% to 100%. Plain conditions can't tell them apart.
2. **Without guidance the failures are the dangerous kind.** Asked to shut down the dev servers,
   the agent listed every Node process on the machine, and its first command, in all three runs,
   was a `kill` of another project's dev session. Asked to free a port, it killed the pid on it.
   It ran the tests against the development database, built `DATABASE_URI` by hand to run a
   script, and removed the database's container and volume with `docker`. It found what had
   restarted the database in 1 of 3 runs; the event log answers that in one command.
3. **What the CLI makes discoverable still works without guidance.** The agent found
   `stackctl service restart` and `stackctl logs` from `--help` in every run on Sonnet. `--help`
   is part of the agent interface.
4. **A skill depends on its line in the listing.** Over budget, the agent loaded the new skill
   in 70% of runs and the old one in 63%, and went around stackctl in the rest. Text that is
   always read doesn't have that failure: `rule` and `all` scored 100% in the same condition.
5. **Always-on text makes the skill redundant in Claude Code.** With the rules file there,
   Sonnet loaded the skill in 0 of 54 runs (6 of 54 with a busy instructions file) and read
   `llms.txt`, then the playbook, straight from the pointer. Haiku loaded both (47 of 54).
6. **A long description cost the old skill.** Its triggers for infra, `docker compose`, `.env`
   and logs sat past the 1,536th character, so they were never shown. It missed
   "Run `docker compose ps`" in 1 of 3 runs on Sonnet and 3 of 3 on Haiku.
7. **A pointer is enough; the index needn't be inlined.** Sent to `llms.txt`, the agent read it
   in every run and went on to the playbook in 87 to 100% of them. That depends on the index's
   opening line, which names the playbook.
8. **Guard-rail lines in the always-on text bought nothing measurable** (100% with and without),
   so they stay in the playbook only.
9. **`CLAUDE.md`, `AGENTS.md` and a rules file work alike in Claude Code**, where each is read.
   `AGENTS.md` is read only in a repo with no `CLAUDE.md`, which most repos that use Claude Code
   have.
10. **The cost is two file reads on tasks that touch the stack.** On a frontend edit and a
    question about the code, no setup made the agent load the skill or read a doc. On a backend
    change that needs a migration, the always-on text sent it to the docs in most runs (about
    16KB: the index and the playbook), which a skill alone rarely did.

## What we chose

The least intrusive setup that scored 100% in every condition is text Claude Code always reads,
in a file stackctl owns.

| Piece | Decision | Why |
| --- | --- | --- |
| `.claude/rules/stackctl.md` | Offered, in one yes-or-no question | Always read by Claude Code, whether or not the repo has a `CLAUDE.md`. stackctl's own file: versioned, hashed, refreshed like the skill, removed by deleting it. 100% alone in every condition. |
| The skill | Offered with the rules file | For agents that load skills and read neither instructions file, and as the description of stackctl in a skill listing. Trimmed to 621 characters; its body is only the pointer. |
| A block in `AGENTS.md` | Only with `stackctl init --agents-md` | The only edit to a file the project owns, and it serves agents this experiment didn't run. Claude Code doesn't read it in a repo with a `CLAUDE.md`. |
| A block in `CLAUDE.md` | Not shipped | Same score as the rules file, and it would edit the project's file to do what the rules file does without. |
| Guard-rail lines, an inlined index | Not shipped | No measurable gain; both repeat the docs. |
| `llms.txt` | Stays the one index | Its first lines send an agent to the playbook, so every pointer names one file. |

How the files get there:

- **A session's first start in a terminal asks once**, one question: the rules file and the
  skill, yes or no. A no is remembered for the checkout. An agent, a script or CI is never
  asked, and gets nothing installed.
- **`stackctl init` asks the same**, `init -y` installs stackctl's own files without asking,
  and `--agents-md` adds the section to `AGENTS.md`.
- **Installing stackctl writes nothing.** Its postinstall only refreshes files that are already
  there. Before, it installed the skill silently where the package manager ran it.
- **What is installed is kept current without asking**, at install and at a session's start, as
  long as nobody edited it.
- **The package ships the skill in `skills/`**, where `pnpm approve` links it. Where pnpm's link
  is there, stackctl offers the rules file alone, and removes a copy of the skill it wrote
  itself and nobody edited.

## Corrections made along the way

The graders and the hook were checked against transcripts as the runs came in. Each fix was
applied to every setup, and the runs it affected were redone.

**Graders**

- A session started with `-s <name>` wasn't recognised as a start: the service's name was read
  as a subcommand. Every guided `start-background` run had been failing for it.
- The control API's infra routes count as the stackctl way, like the CLI's.
- A file name in a refused read (`cat docker-compose.yaml`, `cat src/seed.ts`) no longer counts
  as running Compose or the seed script. Only the parts of a command that act are graded.
- `port-in-use`: an agent that identifies the port as the session's backend and asks before
  stopping it passes.
- `clean-copy`: writing the `.env.<mode>` file of a new mode passes, as the first step of a
  session of its own.
- `url`: the bare proxy address reaches the frontend too, and passes.
- `docker exec` no longer counts as going around stackctl: it is how an agent looks inside a
  container.
- A third outcome, "never acted", was split from "went around stackctl".

**The hook**

It began by refusing anything it couldn't parse, which made agents stop after a harmless read.
It now follows subshells, loops, `$(…)`, `xargs` and `sh -c` when what they run only reads, and
allows `sed` without `-i`, a bounded `docker events`, and a `node -e` or `python3 -c` filter that
reaches nothing outside itself. After the last change, every run in which the hook had refused
a command the final hook allows was redone, in every setup: 24 runs.

**The harness**

- pnpm re-verified dependencies whenever a different copy of the workspace ran a script, which
  would have raced on the shared `node_modules`; that check is off in the eval's workspace.
- In the end-to-end check, the copies' config is a link to the base's, since a stackctl command
  that acts on a session checks it was started from the same config file. Without it, the first
  attempt's results were an artifact and were discarded.

## Limits

- **Claude Code only.** The `AGENTS.md` setup shows that Claude Code reads the block when there
  is no `CLAUDE.md`. Codex, Cursor and Copilot weren't run.
- **Three runs per task per setup**, one example repo, one day. A 2-point difference between two
  setups is noise; 46% against 100% is not.
- **Choice, not completion**, except in the end-to-end check, whose `none` row is a rough
  comparison.
- **The read-only hook shapes the tail of a run.** A run that ends without trying anything shows
  as "never acted": 9 to 15% of the no-guidance runs, none of the guided ones. In three of those
  on `restart-db`, the agent found two Postgres containers for the project (development and
  test) and asked which one was meant.
- **"Over budget" was forced** with a fixed listing budget; the default budget on a 1M-token
  model held all 43 skills.
- **The workspace's path names the harness**, which one no-guidance agent picked up on. It is
  the same for every setup.
- **The survey of other projects is second-hand**, as marked.

## Running it again

```bash
pnpm build
work=$(mktemp -d)
node maintenance/scripts/agent-eval/eval.ts setup --work "$work"
node maintenance/scripts/agent-eval/eval.ts run   --work "$work" --out .local/agent-runs/<name>
```

[`maintenance/scripts/agent-eval/README.md`](../scripts/agent-eval/README.md) has the options, the
conditions, the end-to-end check and how to add a task. Run it after changing the skill
(`packages/stackctl/skills/stackctl/SKILL.md`), the always-on text
(`packages/stackctl/assets/agent-rules.md`), the playbook or `llms.txt`. The transcripts stay
out of the repo: they hold the machine's paths and process list.

## For the next package

1. **Ship the docs in the package**, as Markdown with an `llms.txt` index, so an agent reads the
   installed version. Make the index's first lines say where an agent starts.
2. **Write one always-on paragraph:** what the tool owns in the repo, in the words a task would
   use, and one path to read before touching any of it. Keep rules and recipes in the docs.
3. **Put it where the agent always reads, in a file of your own:** `.claude/rules/<tool>.md` for
   Claude Code. Offer a marked block in `AGENTS.md` for the others, and ask first.
4. **Add a skill with the same scope as its description**, under 1,024 characters, the main use
   first, and a body that is only the pointer. Ship it in `skills/<name>/SKILL.md`, where pnpm
   and the skills tools look.
5. **Offer, don't install.** Ask a person one question, once, at a moment they are at a
   terminal; give scripts a flag; keep what was accepted current without asking.
6. **Make the CLI's `--help` say enough to act on.** It is what an agent with no guidance finds.
7. **Measure before and after.** Copy `maintenance/scripts/agent-eval/`: prompts phrased as a
   person would, a hook that refuses every change, grading on the first command tried. Include tasks that name
   the wrong tool, a crowded skill listing and a smaller model: the plain cases hide every
   difference between setups.
