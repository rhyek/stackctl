/**
 * The workspace the e2e suite runs stackctl in: a temp directory per test file, with a
 * `stackctl.config.ts` and three plain Node services — `api`, `web` (which needs `api` and waits
 * for its healthcheck) and `worker`. No infra, no Docker, no dev reverse proxy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDir, packageDir } from './cli.js';

/**
 * The ports the fixture uses, from stackctl's block in the port registry (21050–21099): 21080–21089,
 * which no spec and not the example use.
 */
export const PORTS = {
  api: 21081,
  web: 21082,
  /** The control API's port when a test pins it (`E2E_API_PORT`). */
  pinnedControl: 21085,
} as const;

export const FIXTURE_PORTS = Array.from({ length: 10 }, (_, i) => 21080 + i);

const CONFIG = `import fs from 'node:fs';
import { defineConfig } from 'stackctl';

// The crash scenario: the config's own code throws, once the TUI is up and the test says so by
// creating the file \`E2E_CRASH_TRIGGER\` names.
const trigger = process.env.E2E_CRASH_TRIGGER;
if (trigger) {
  setInterval(() => {
    if (fs.existsSync(trigger)) {
      throw new Error('e2e crash from the config');
    }
  }, 50).unref();
}

export default defineConfig({
  serviceRootDir: 'apps',
  // The failed-startup scenario pins the control API to a port the test holds.
  ...(process.env.E2E_API_PORT ? { apiPort: Number(process.env.E2E_API_PORT) } : {}),
  services: {
    api: { port: ${String(PORTS.api)}, healthcheck: '/health' },
    web: {
      port: ${String(PORTS.web)},
      healthcheck: '/health',
      deps: [{ service: 'api', wait: true }],
    },
    worker: {},
  },
});
`;

/**
 * Every service's dev process: an HTTP server on \`PORT\` (or any free port, without one) that logs
 * a line once it listens, answers \`/health\` (with 503 for its first \`readyAfterMs\`), and exits
 * on SIGTERM or SIGINT. It records its pid in \`.e2e-pids/\` while it runs, so a test can find it
 * if stackctl didn't stop it, and exits on its own once the run it belongs to is gone.
 */
const SERVER = `import fs from 'node:fs';
import http from 'node:http';

const [name = 'service', readyAfter = '0'] = process.argv.slice(2);
const started = Date.now();
const pids = new URL('./.e2e-pids/', import.meta.url);
fs.mkdirSync(pids, { recursive: true });
const pidFile = new URL(\`\${name}-\${String(process.pid)}\`, pids);
fs.writeFileSync(pidFile, String(process.pid));
process.on('exit', () => fs.rmSync(pidFile, { force: true }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const owner = Number(process.env.E2E_DRIVER_PID ?? process.env.E2E_OWNER_PID);
setInterval(() => {
  try {
    process.kill(owner, 0);
  } catch {
    process.exit(0);
  }
}, 500).unref();

const server = http.createServer((req, res) => {
  const ready = Date.now() - started >= Number(readyAfter);
  res.writeHead(req.url === '/health' && !ready ? 503 : 200).end(name);
});
server.listen(Number(process.env.PORT ?? 0), () => {
  const address = server.address();
  console.log(\`\${name} listening on \${String(typeof address === 'object' && address ? address.port : '')}\`);
});
`;

/** The script the run screen's commands menu offers for `web`, beside `dev`. */
export const WEB_SCRIPT = 'say-hello';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Creates the workspace in a new temp directory and returns its path. `stackctl` resolves
 * there to the suite's own build through a stand-in package directory, so the config registers
 * with the module instance the CLI runs.
 */
export function createWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-e2e-')));
  writeJson(path.join(ws, 'package.json'), {
    name: 'e2e-workspace',
    private: true,
    type: 'module',
  });
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  fs.writeFileSync(path.join(ws, 'stackctl.config.ts'), CONFIG);
  fs.writeFileSync(path.join(ws, 'server.ts'), SERVER);
  const service = (name: string, scripts: Record<string, string>) =>
    writeJson(path.join(ws, 'apps', name, 'package.json'), {
      name,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts,
    });
  // api isn't ready for its first second, so web is seen waiting for it.
  service('api', { dev: 'node ../../server.ts api 1000' });
  service('web', { dev: 'node ../../server.ts web', [WEB_SCRIPT]: 'echo hello from the web menu' });
  service('worker', { dev: 'node ../../server.ts worker' });

  const standIn = path.join(ws, 'node_modules', 'stackctl');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
  for (const dir of ['assets', 'skills']) {
    fs.symlinkSync(path.join(buildDir, '..', dir), path.join(standIn, dir));
  }
  declineGuidance(ws);
  return ws;
}

/**
 * Answers the offer of the agent guidance with a no, as a person who was already asked: a
 * session started at a terminal then goes straight to its picker, whoever runs the suite.
 */
export function declineGuidance(ws: string): void {
  writeJson(path.join(ws, 'node_modules', '.stackctl', 'agent-guidance.json'), { declined: true });
}

/** The session record of `mode` in `ws`, or `null` when there is none. */
export function sessionRecord(
  ws: string,
  mode = 'development',
): { pid: number; port: number } | null {
  const file = path.join(ws, 'node_modules', '.stackctl', 'modes', mode, 'running.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; port: number };
  } catch {
    return null;
  }
}
