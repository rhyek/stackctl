#!/usr/bin/env bash
# Runs Claude Code once, isolated, in a copy of the example workspace, and keeps its whole run as
# stream-json: the raw material of a conversation in index.ts. See README.md.
#
#   ./scripts/demo/conversations/capture.sh <work-dir> <out.jsonl> "<prompt>"
#
# <work-dir> holds the copy (<work-dir>/home/example, made on the first run and kept, so a
# session started there survives between runs) and Claude Code's throwaway config. Isolated
# means: a HOME and config directory of its own, so none of your own CLAUDE.md, skills, plugins,
# hooks or memory reach it; the copy is outside any git repository, so neither this repo's
# CLAUDE.md and skills nor a git status do; and all it is told about stackctl is what a yes to
# stackctl's offer installs: the rules file and the skill. Requires `pnpm build` and a token from
# `claude setup-token` in .local/claude-oauth-token.
set -euo pipefail

work=$1
out=$2
prompt=$3
repo=$(cd "$(dirname "$0")/../../.." && pwd)
token="$repo/.local/claude-oauth-token"
[ -s "$token" ] || {
  echo "error: no token at $token: run \`claude setup-token\` and save what it prints there" >&2
  exit 1
}

mkdir -p "$work/home/.claude-config"
home=$(cd "$work/home" && pwd)
if [ ! -d "$home/example" ]; then
  # A clone of the example; its node_modules link to ../packages/stackctl, which this makes.
  cp -a -c "$repo/example" "$home/example"
  rm -rf "$home/example/node_modules/.stackctl" "$home/example/.claude"
  ln -sfn "$repo/packages" "$home/packages"
fi
(cd "$home/example" && node -e "
  Promise.all([
    import('../packages/stackctl/dist/skill.js'),
    import('../packages/stackctl/dist/agent-guidance.js'),
  ]).then(([{ readOwnVersion }, { installGuidance }]) =>
    // what a yes to the offer installs: stackctl's own files, and no AGENTS.md section
    installGuidance({ cwd: process.cwd(), version: readOwnVersion(), own: true, agentsMd: false }));
")

# Your own CLAUDE.md is found through your real home, whatever HOME says: exclude it, and where
# its links point.
excludes=("$HOME/.claude/**")
for link in "$HOME/.claude/CLAUDE.md" "$HOME/.claude/rules"; do
  [ -L "$link" ] && excludes+=("$(dirname "$(readlink "$link")")/**")
done
settings=$(node -e 'console.log(JSON.stringify({ claudeMdExcludes: process.argv.slice(1) }))' \
  "${excludes[@]}")

# What the playbook's recipes run is approved, as a person clicking "yes" would; anything that
# could reach past the copy is refused.
allow=(Read Glob Grep Skill
  "Bash(pnpm:*)" "Bash(npx stackctl:*)" "Bash(./node_modules/.bin/stackctl:*)"
  "Bash(curl:*)" "Bash(cat:*)" "Bash(ls:*)" "Bash(jq:*)" "Bash(grep:*)" "Bash(head:*)"
  "Bash(tail:*)" "Bash(sed -n:*)" "Bash(wc:*)" "Bash(sleep:*)" "Bash(test:*)" "Bash(ps:*)"
  "Bash(echo:*)" "Bash(date:*)" "Bash(node -e:*)" "Bash(node --input-type=module -e:*)")
deny=("Bash(kill:*)" "Bash(pkill:*)" "Bash(killall:*)" "Bash(lsof:*)" "Bash(rm:*)")

# Tools installed under your home keep working with HOME elsewhere: Docker's compose plugin, and
# asdf's installs behind its shims.
asdf=${ASDF_DATA_DIR:-$HOME/.asdf}
cd "$home/example"
env -i HOME="$home" CLAUDE_CONFIG_DIR="$home/.claude-config" PATH="$PATH" TERM=xterm-256color \
  LANG=en_US.UTF-8 DOCKER_CONFIG="$HOME/.docker" ASDF_DATA_DIR="$asdf" \
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$token")" \
  claude --no-session-persistence --settings "$settings" --model sonnet \
  -p "$prompt" --output-format stream-json --verbose \
  --allowedTools "${allow[@]}" --disallowedTools "${deny[@]}" \
  < /dev/null > "$out"
echo "capture.sh: $(wc -l < "$out" | tr -d ' ') events in $out"
