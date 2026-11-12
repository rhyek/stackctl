# The agent eval

**TL;DR.** Measures how well each way of telling a coding agent about stackctl works. It asks
Claude Code the same questions in the same workspace under each setup (the skill, the rules file,
the `AGENTS.md` block, none of them, all of them) and grades what the agent did. Run it after
changing `skills/stackctl/SKILL.md`, `assets/agent-rules.md`, the playbook or `llms.txt`:

```bash
pnpm build
work=$(mktemp -d)                      # outside any git repository
node scripts/agent-eval/eval.ts setup --work "$work"
node scripts/agent-eval/eval.ts run   --work "$work" --out .local/agent-runs/<name>
```

The findings of the first run, and what they changed, are in
[`maintenance/docs/agent-guidance-experiment.md`](../../maintenance/docs/agent-guidance-experiment.md).

## Running it

Needs Docker, the example's ports free, and a token from `claude setup-token` in
`.local/claude-oauth-token`. Each run is one Claude Code request on your subscription; most take
10 to 40 seconds.

1. **`setup`** copies `example/` to `<work>/base`, strips its tutorial comments (a real repo's
   config doesn't explain stackctl), and makes one copy per setup under `<work>/setups/`, each
   with that setup's files. The copies share the base's `node_modules`, so they all see the one
   session the base runs.
2. **`run`** puts that session in the state each task needs, then runs every task under every
   setup. It skips runs already in `--out`, so a stopped batch resumes.

| Option          | Default | What it does                                             |
| --------------- | ------- | -------------------------------------------------------- |
| `--setups a,b`  | all     | Only these setups, each with its conditions: `skill+crowded`. |
| `--tasks x,y`   | all     | Only these tasks.                                        |
| `--reps`        | `3`     | Runs per task per setup.                                 |
| `--concurrency` | `4`     | Runs at once.                                            |
| `--model`       | `sonnet` | The model Claude Code runs.                             |

3. **`report --out <dir>`** grades the transcripts again and rewrites `report.md` (the tables),
   `results.json` (one row per run) and `review.txt` (each verdict with the command or answer it
   rests on). Grading reads the saved transcripts, so a grader fix needs no new runs, except
   for the runs it leaves cut short: **`prune --out <dir>`** deletes those, and `run` redoes them.
4. **`show.ts <run.jsonl>`** prints one run in short.
5. **`e2e --work <dir> --out <dir>`** runs two tasks for real, one at a time, and judges each by
   what is true afterwards: see [the end-to-end check](#the-end-to-end-check).

A setup takes conditions as suffixes, which make it harder:

| Condition     | What it adds                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `+busy`       | A page of unrelated rules in the project's instructions file, before stackctl's. |
| `+crowded`    | Other skills installed for the user: pass `setup --home-skills <dir>`, a directory of skill folders. |
| `+overbudget` | The same, with the skill listing held to 8,000 characters, so stackctl's skill is listed by name only. |

Stop the session when you are done: `(cd <work>/base/example && pnpm stackctl stop)`.

## How a run is graded

- **Nothing an agent runs can change anything.** `guard.ts` is a hook on every Bash command: it
  runs a command only when every part of it reads, and refuses the rest. The refused command is
  still in the transcript, and that is what gets graded. So the session survives every run, runs
  can go in parallel, and an agent told to "shut down the dev servers" can't reach another
  project's processes.
- **Action tasks** are graded on the first refused command the task's `decide` knows: the
  stackctl way passes, a way around it (a `kill`, a bare `docker compose`, the test script run
  directly) fails. The run is stopped there. A run that never tries anything is `never acted`.
- **Answer tasks** run to their end and are graded on the answer, or on what the agent read.
- **Control tasks** have nothing to do with stackctl. They only record whether the agent loaded
  the skill or read the docs anyway.

This measures whether the agent chose the right command, not whether the task then succeeded.

## The end-to-end check

`e2e` runs `app-down` and `run-tests` with the guard in its second mode: a command may also act
through stackctl or the project's test script. A `kill`, a service started by hand and every
docker command that changes something stay refused, since they would reach past the session or
leave a process stackctl doesn't own. It runs one agent at a time, puts the session in the
task's state before each, and checks afterwards that every service is ready, or that the tests
passed in the test mode with the development session untouched and the test session stopped.

## Extending it

- **A setup** is an entry in `setups` in `lib.ts`: the files it adds to the workspace.
- **A task** is an entry in `tasks`: the session's `state`, a `prompt` with no stackctl words, and
  `decide` (for a refused command: `'pass'`, `'fail'` or `null`) or `passes` (for a finished run).
- **Check a new grader against transcripts.** Run the task once per setup, then read
  `review.txt`: every `undecided:` line is a refused command `decide` returned `null` for, and
  every `never acted` is a run to open with `show.ts`.
- **A command the guard wrongly refuses** makes agents give up. Add it to `guard.ts`, with a
  case in `eval.spec.ts` (`pnpm test` runs it), and keep the rule that anything not known to
  read is refused.

Keep the transcripts out of the repo: they hold the machine's paths and process list.
