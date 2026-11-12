import { describe, expect, test } from 'vitest';
import { allowed, allowedToAct } from './guard.ts';
import { grade, stackctlCalls, startsSession, tasks } from './lib.ts';
import type { Run } from './lib.ts';

// The guard is what keeps an agent under test away from the session and from every other
// project's processes: a command it wrongly allows runs for real.

// oxfmt-ignore
const reads = [
  'pnpm stackctl status', 'pnpm stackctl status --json | jq .status.services', 'pnpm stackctl show-config | jq \'.services | map_values({ port, publicOrigin })\'',
  'cd apps/backend && cat package.json', 'pnpm stackctl --mode test status 2>&1 | head -20', 'pnpm stackctl events -n 20', 'pnpm stackctl logs --help',
  'pnpm stackctl infra docker-compose ps', 'docker ps --format "{{.Names}}"', 'docker compose ps', 'curl -s http://localhost:3001/health', 'curl -s localhost:14003/query/status | jq .',
  'ls -la node_modules/.stackctl/modes/development 2>/dev/null', 'cat node_modules/.stackctl/modes/development/running.json', 'lsof -i :3001', 'ps aux | grep node | head',
  'curl -sN http://localhost:14003/events | grep -m1 ready', 'pnpm exec stackctl status', 'npx stackctl show-config', 'pnpm stackctl infra --help', 'NO_COLOR=1 pnpm stackctl status',
  'find . -name "*.log" -not -path "./node_modules/*"',
  'ls && (pnpm stackctl status 2>&1 | head -30); pnpm stackctl show-config 2>&1 | jq \'{services: (.services | map_values({port, publicOrigin, healthcheck}))}\'',
  'for p in 1677 58952; do echo "== $p"; ps -o ppid=,etime=,command= -p $p | cut -c1-220; lsof -a -p $p -d cwd -Fn | grep \'^n\'; done',
  'ls -la; (docker ps -a --format \'{{.Names}}\' 2>&1 | head -20); (brew services list 2>&1 | head -20); uptime',
  'if [ -f x ]; then cat x; else echo none; fi', '{ ls; pwd; }', 'docker info >/dev/null 2>&1 && echo docker ok || echo no docker', 'ls apps/{backend,frontend}',
  'PORT=14090; curl -s localhost:$PORT/query/status',
  "cat .env.development | sed -E 's/(PASSWORD|SECRET|KEY)=.*/\\1=<redacted>/'", "pnpm stackctl show-config 2>&1 | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{console.log(JSON.stringify(JSON.parse(s).services.worker))})'",
  "pnpm stackctl status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"running\"])'",
  "ls -a | grep '^\\.env' | xargs -I{} sh -c 'echo \"== {}\"; cat {}'", 'find . -name "*.md" | xargs grep -l stackctl', 'ls | xargs -n1 basename', "sh -c 'ls; pwd'",
  'for p in 1677 60152; do echo $p $(lsof -a -p $p -d cwd -Fn | grep ^n); done', 'echo "cwd: $(pwd)" && cat "$(ls -t node_modules/.stackctl/modes/development/logs/*.log | head -1)" | tail -5',
  'docker events --since 2h --until 0s --filter container=x', 'echo $((1+2))', 'P=$(pnpm stackctl status --json | jq .port); curl -s localhost:$P/query/status', 'ls `pwd`', 'sed -n 1,20p stackctl.config.ts', 'grep -rn "x|y" src',
];

// oxfmt-ignore
const changes = [
  'pnpm stackctl service restart -s backend', 'pnpm stackctl stop', 'pnpm stackctl infra reset', 'pnpm stackctl', 'pnpm dev', 'pnpm stackctl --headless -s backend &',
  'kill 123', 'pkill -f stackctl', 'lsof -ti :3001 | xargs kill', 'curl -X POST http://localhost:14003/command/quit', 'curl -s -XPOST localhost:14003/command/quit',
  'curl -s https://stackctl.dev/llms.txt', 'docker compose down -v', 'docker restart example-development-db-1', 'pnpm stackctl status > out.txt', 
  'echo hi; rm -rf x', 'pnpm stackctl infra docker-compose restart db', 'pnpm stackctl --mode test run backend test', 'pnpm test', 'node --test', 'env', 'printenv',
  'pnpm stackctl exec backend -- node src/seed.ts', 'curl -d x localhost:14003/command/quit', 'pnpm stackctl status && pnpm stackctl stop', 'find . -name x -delete', 'sed -i "" s/a/b/ f', "sed -E -i.bak s/a/b/ f",
  'pnpm --filter backend dev', "node -e 'require(\"child_process\").execSync(\"kill 1\")'", "python3 -c 'import os; os.kill(1, 9)'", "sed 's/a/b/w out.txt' f", "node -e 'process.kill(1)'", 'lsof -ti :3001 | xargs kill -9', "ls | xargs -I{} sh -c 'rm {}'", "sh -c 'pnpm stackctl stop'", 'pgrep node | xargs -n1 kill', 'echo x | xargs xargs rm', 'kill $(lsof -ti :3001)', 'echo $(pnpm stackctl stop)', 'cat "$(rm -rf x)"', 'echo `pkill node`', 'docker events', 'kill -TERM 1 2; sleep 5; ps -p 1',
  'cat <(pnpm stackctl stop)', 'echo "$(curl -X POST localhost:14090/command/quit)"', 'for p in 1 2; do kill $p; done', '(pnpm dev > /tmp/x.log 2>&1 &); sleep 20', 'if true; then pnpm stackctl stop; fi', '{ pnpm stackctl stop; }',
  '(cd apps/backend && pnpm test)', 'while true; do pnpm stackctl infra reset; done', 'make start', 'docker exec -it db psql', 'pnpm stackctl infra start', 'pnpm stackctl reset', 'curl -sd@f localhost:1/x', 'cat <<EOF > f\nx\nEOF',
];

describe('the guard, grading runs', () => {
  test.each(reads)('lets a command that only reads run: %s', (command) => {
    expect(allowed(command)).toBe(true);
  });

  test.each(changes)('refuses a command that could change something: %s', (command) => {
    expect(allowed(command)).toBe(false);
  });
});

describe('the guard, in the end-to-end check', () => {
  // oxfmt-ignore
  test.each([
    'pnpm stackctl service restart -s backend', 'pnpm stackctl --mode test --headless -s backend > /tmp/test-session.log 2>&1 &',
    'pnpm stackctl --mode test run backend test', 'pnpm stackctl --mode test stop; pnpm stackctl status', 'cd apps/backend && pnpm test 2>&1 | tail -40',
    'PORT=3001 pnpm --filter backend test', 'pnpm dev', 'sleep 60; tail -20 /tmp/x.log', 'nohup npx stackctl --mode test --headless -s backend > /tmp/s.log 2>&1 &',
    'node --test test/todos.spec.ts', 'pnpm stackctl infra restart -s db && pnpm stackctl status',
  ])('lets stackctl and the test script take effect: %s', (command) => {
    expect(allowedToAct(command)).toBe(true);
  });

  // oxfmt-ignore
  test.each([
    'kill 123', 'pkill -f stackctl', 'docker restart example-development-db-1', 'docker compose up -d', 'cd apps/backend && pnpm dev', 'pnpm --filter backend dev',
    'node src/index.ts', 'curl -X POST localhost:14016/command/quit', 'rm -rf node_modules', 'pnpm stackctl status > out.txt', 'make start', 'lsof -ti :3001 | xargs kill',
    'pnpm install', 'echo x > /etc/hosts', "node -e 'process.kill(1)'",
  ])('still refuses what reaches past the session: %s', (command) => {
    expect(allowedToAct(command)).toBe(false);
  });
});

describe('reading a command', () => {
  test('the guard knows the CLI run by its file', () => {
    expect(allowed('node node_modules/stackctl/dist/cli.js --help 2>&1 | head -40')).toBe(true);
    expect(allowed('node node_modules/stackctl/dist/cli.js stop')).toBe(false);
  });

  test('finds each stackctl call, its mode apart from its arguments', () => {
    expect(
      stackctlCalls('cd x && pnpm stackctl --mode test run backend test 2>&1 | tail -5'),
    ).toEqual([{ mode: 'test', args: ['run', 'backend', 'test'] }]);
    expect(stackctlCalls('npx stackctl status; node_modules/.bin/stackctl -m test stop')).toEqual([
      { mode: null, args: ['status'] },
      { mode: 'test', args: ['stop'] },
    ]);
  });

  test('knows a session start from a subcommand, a flag value and a service started by hand', () => {
    expect(startsSession('pnpm stackctl --headless -s backend -s frontend')).toBe(true);
    expect(startsSession('pnpm dev > /tmp/dev.log 2>&1 &')).toBe(true);
    expect(startsSession('pnpm stackctl service restart -s backend')).toBe(false);
    expect(startsSession('pnpm stackctl status')).toBe(false);
    expect(startsSession('cd apps/backend && pnpm dev')).toBe(false);
    expect(startsSession('pnpm --filter backend dev')).toBe(false);
  });
});

describe('grading', () => {
  const run = (...commands: string[]): Run => ({
    steps: commands.map((text) => ({ tool: 'Bash', text })),
    answer: '',
    finished: true,
    turns: null,
    costUsd: null,
    outputTokens: null,
    model: null,
  });

  test('the first command that would change something decides an action task', () => {
    const task = tasks['stop-stack']!;
    expect(grade(task, run('pnpm stackctl status', 'pnpm stackctl stop')).outcome).toBe('pass');
    expect(grade(task, run('lsof -i :3001', 'kill 123', 'pnpm stackctl stop')).outcome).toBe(
      'wrong',
    );
    expect(grade(task, run('pnpm stackctl status')).outcome).toBe('none');
  });

  test('a file a refused command only prints decides nothing', () => {
    // refused for its last part; `docker-compose.yaml` and `seed.ts` are only read
    const looked = 'cat docker-compose.yaml libs/db/src/seed.ts; echo done > /tmp/notes.txt';
    expect(grade(tasks['reset-db']!, run(looked, 'pnpm stackctl infra reset -s db')).outcome).toBe(
      'pass',
    );
    expect(grade(tasks['run-script']!, run(looked, 'pnpm stackctl run libs/db seed')).outcome).toBe(
      'pass',
    );
  });

  test('a bare docker compose fails where `stackctl infra docker-compose` passes', () => {
    const task = tasks['restart-db']!;
    expect(grade(task, run('docker compose restart db')).outcome).toBe('wrong');
    expect(grade(task, run('pnpm stackctl infra docker-compose restart db')).outcome).toBe('pass');
    expect(grade(task, run('pnpm stackctl infra restart -s db')).outcome).toBe('pass');
  });

  test('tests pass only in the test mode', () => {
    const task = tasks['run-tests']!;
    expect(grade(task, run('cd apps/backend && pnpm test')).outcome).toBe('wrong');
    expect(grade(task, run('pnpm stackctl run backend test')).outcome).toBe('wrong');
    expect(grade(task, run('pnpm stackctl --mode test --headless -s backend')).outcome).toBe(
      'pass',
    );
  });
});
