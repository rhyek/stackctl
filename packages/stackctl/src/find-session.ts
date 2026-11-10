import fs from 'node:fs';
import { type ControlClient, createControlClient, type SessionStatus } from './control-client.js';
import { currentMode } from './env-base.js';
import { isInsideWorkspace, isProcessAlive, processCwd, resolveRealPath } from './process-info.js';
import type { ServiceName } from './register.js';
import { readRunning, type RunningState } from './running.js';

/**
 * A workspace's session in a mode, as its `modes/<mode>/running.json` and its control API tell it:
 *
 * - `none`: no record, or one whose pid is gone or now belongs to a process outside the
 *   workspace — a record left behind, which the next session overwrites.
 * - `running`: the recorded pid is alive and its control API answers with the recorded session
 *   id (and, given one, the same config): that session, with a client bound to it.
 * - `unresponsive`: the recorded pid is alive, in the workspace, but its control API doesn't
 *   answer (`hung`) or answers as another session (`mismatch`). Nothing may take it for the
 *   session, nor start another in its place unasked.
 */
export type FoundSession<P extends string = ServiceName> =
  | { kind: 'none' }
  | {
      kind: 'running';
      client: ControlClient<P>;
      status: SessionStatus<P>;
      /** The record it was found by; null when a pinned `apiPort` found it without one. */
      record: RunningState | null;
    }
  | { kind: 'unresponsive'; pid: number; port: number; reason: 'hung' | 'mismatch' };

/** How long a silent control API is given before its session counts as hung. */
const SETTLE_MS = 2000;
const POLL_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A path with its symlinks resolved, or as given when it doesn't exist. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * This workspace's session in `mode` (the active one unless given): the one place a session
 * record is read and checked before anything trusts it. See {@link FoundSession}.
 */
export async function findSession<P extends string = ServiceName>(opts: {
  workspaceDir: string;
  mode?: string;
  /** The config the caller loaded: a session started from another one is not this one. */
  configPath?: string;
  /** The config's `apiPort`, when it pins one: where the session listens, record or not. */
  apiPort?: number;
  /** How long a silent control API is waited on before it counts as hung; default 2 s. */
  settleMs?: number;
}): Promise<FoundSession<P>> {
  const mode = opts.mode ?? currentMode();
  const record = readRunning(opts.workspaceDir, mode);
  const sameConfig = (status: SessionStatus<P>) =>
    opts.configPath === undefined || realPath(status.configPath) === realPath(opts.configPath);

  if (!record) {
    // A pinned port is where this config's session listens, even when it left no record.
    if (opts.apiPort === undefined) {
      return { kind: 'none' };
    }
    const client = createControlClient<P>(opts.apiPort);
    const status = await client.query.status();
    return status && status.mode === mode && sameConfig(status)
      ? { kind: 'running', client, status, record: null }
      : { kind: 'none' };
  }
  if (!isProcessAlive(record.pid)) {
    return { kind: 'none' };
  }

  const port = opts.apiPort ?? record.port;
  const client = createControlClient<P>(port);
  const deadline = Date.now() + (opts.settleMs ?? SETTLE_MS);
  let answered: SessionStatus<P> | null = null;
  for (;;) {
    answered = await client.query.status();
    if (answered) {
      break;
    }
    if (!isProcessAlive(record.pid)) {
      return { kind: 'none' };
    }
    // The record is written just before the control API listens: give it a moment.
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(POLL_MS);
  }
  if (
    answered &&
    answered.pid === record.pid &&
    answered.sessionId === (record.sessionId ?? null) &&
    answered.mode === mode &&
    sameConfig(answered)
  ) {
    return { kind: 'running', client, status: answered, record };
  }
  // Alive, but not answering as the recorded session. A pid the system gave to a process outside
  // the workspace means the session is long gone; one inside it may be the session itself.
  const cwd = await processCwd(record.pid);
  if (
    cwd !== null &&
    !isInsideWorkspace(resolveRealPath(opts.workspaceDir), resolveRealPath(cwd))
  ) {
    return { kind: 'none' };
  }
  return { kind: 'unresponsive', pid: record.pid, port, reason: answered ? 'mismatch' : 'hung' };
}

/** Why an {@link FoundSession} `unresponsive` session can't be used, for an error message. */
export function unresponsiveMessage(
  found: Extract<FoundSession, { kind: 'unresponsive' }>,
  mode: string,
): string {
  return found.reason === 'hung'
    ? `a ${mode} session is recorded as running (pid ${String(found.pid)}) but doesn't answer on its control API (port ${String(found.port)}): it looks hung`
    : `a ${mode} session is recorded as running (pid ${String(found.pid)}), but what answers on its control API (port ${String(found.port)}) is another session: the pid may have been reused`;
}

/**
 * A {@link ControlClient} for the running session of **this** config in **this** mode, or
 * `undefined` when {@link findSession} finds none answering.
 */
export async function connectSessionControl(opts: {
  workspaceDir: string;
  /** Absolute path to the config the caller loaded. */
  configPath: string;
  mode: string;
  /** The config's `apiPort`, when it pins one. */
  apiPort?: number;
}): Promise<ControlClient | undefined> {
  const found = await findSession(opts);
  return found.kind === 'running' ? found.client : undefined;
}

/**
 * A {@link ControlClient} for this workspace's running session in `mode` (the active one unless
 * given), or null when {@link findSession} finds none answering.
 */
export async function connectControlClient(
  cwd: string = process.cwd(),
  mode?: string,
): Promise<ControlClient | null> {
  const found = await findSession({ workspaceDir: cwd, mode });
  return found.kind === 'running' ? found.client : null;
}
