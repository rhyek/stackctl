# The agent conversations

`index.ts` holds the coding-agent conversations the AI overview page plays (`docs/ai/overview.md`,
"What it looks like"; the second one is on the home page too): real runs of Claude Code with what stackctl offers to install (the
rules file and the skill) against the example workspace, replayed by `../agent-chat.ts` and recorded like any other scene
(`agent-restart`, `agent-tests` in `../scenes.ts`).

A replay plays the same every time, so re-recording one changes nothing. A conversation goes
stale when the agent would act differently: after a change to the skill or the rules file
(`packages/stackctl/assets/`), the playbook (`docs/ai/playbook.md`), or a command the
conversation runs. Capture it again then.

## Capturing a conversation

Needs `pnpm build`, Docker, the example's ports free, and a token from `claude setup-token` saved
in `.local/claude-oauth-token`. Each run is one Claude Code request on your subscription.

1. **Set the scene** in a copy of the example. `capture.sh` makes it on its first run, under the
   work directory you give it (`<work>/home/example`). For `restart`, start a development
   session there (`pnpm stackctl --headless -s backend -s worker -s frontend`), make a request to
   the backend (`curl localhost:3001/todos`), and restart its Postgres within ten seconds
   (`pnpm stackctl infra restart -s db`), from a shell with no agent's variables, so the event
   log says a person did it: the backend's pg pool has no `error` handler, so it crashes. `tests`
   needs no session.
2. **Run it:** `./maintenance/scripts/demo/conversations/capture.sh <work> <out.jsonl> "<prompt>"`,
   with the prompt a person would type: no stackctl words.
3. **Read the run.** A detour the setup caused (a refused command, a stray process) is the
   setup's to fix, not the guidance's. A detour stackctl caused is a finding: fix the playbook
   or the page it sent the agent to, `pnpm build`, and run again. To measure a change across
   many tasks, not one conversation, use
   [`maintenance/scripts/agent-eval/`](../../agent-eval/README.md).
4. **Copy it into `index.ts`**: each tool call, its output's first lines as Claude Code shows them
   and how many more it had, and the replies. Write paths relative to the workspace, and keep
   nothing of the machine it ran on. Leave out only what the setup caused.
5. **Re-record:** `./maintenance/scripts/demo/record.sh agent-restart agent-tests`.

Keep the raw `.jsonl` out of the repo: it holds the machine's paths.
