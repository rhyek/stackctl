import path from 'node:path';
import { getLoadedConfig } from '../config.js';
import { currentMode } from '../env-base.js';
import { findSession, unresponsiveMessage } from '../find-session.js';
import { findConfigPath } from '../load-config.js';
import { renderAppInProduction } from '../render-app-production.js';
import { sessionId } from '../running.js';
import { sessionLogPath } from '../session-files.js';
import { runHeadless } from '../session/headless.js';
import { buildSessionPlan } from '../session/plan.js';
import { Session } from '../session/session.js';
import { preflightTakeover } from '../takeover.js';
import { type StartOptions, resolveSelectedNamesOrExit } from './default.js';

// A dev session: `--headless`, streaming to stdout, or the TUI.

/**
 * Why a forked session (`startStack()`'s) must not start, or `undefined` when it may: a session of
 * its mode is running, or recorded alive, and `--kill-others` didn't say to quit it. A forked
 * session never quits one unasked, whoever started it.
 */
async function forkedSessionRefusal(
  configPath: string,
  killOthers: boolean,
): Promise<string | undefined> {
  if (killOthers) {
    return undefined;
  }
  const mode = currentMode();
  const found = await findSession({
    workspaceDir: process.cwd(),
    mode,
    configPath,
    apiPort: getLoadedConfig()?.apiPort,
  });
  if (found.kind === 'running') {
    return `a ${mode} session of this workspace is already running (pid ${String(found.status.pid)}); quit it, or start with killOthers to have it quit first`; // oxfmt-ignore
  }
  if (found.kind === 'unresponsive') {
    return `${unresponsiveMessage(found, mode)}; stop it, or start with killOthers to have it killed`;
  }
  return undefined;
}

/** Starts the session the options ask for. It ends by exiting the process. */
export async function runDevSession(opts: StartOptions): Promise<void> {
  const logFile = sessionLogPath(process.cwd(), currentMode(), sessionId());
  const configPath =
    findConfigPath(process.cwd()) ?? path.join(process.cwd(), 'stackctl.config.ts');

  // Resolved before the preflight below, so a `--headless` invocation that can't name its
  // packages fails with that usage error instead of first asking whether to quit a session
  // it was never going to start.
  const plainNames = opts.headless ? resolveSelectedNamesOrExit(opts, '--headless') : null;

  // Settle what happens to a session already running for this project *before* anything
  // starts. Acquisition frees the dev ports by killing whatever in this workspace holds
  // them, so once it begins the other session is gone either way — declining has to mean
  // exiting here. Shared by both the --headless and TUI paths, and deliberately ahead of the
  // TUI's alternate screen, so the prompt is an ordinary terminal prompt.
  // Forked by `startStack()`: it ends with its parent, and reports to it over the channel.
  const forked = process.channel !== undefined;
  if (forked) {
    const refusal = await forkedSessionRefusal(configPath, opts.killOthers);
    if (refusal) {
      console.error(`stackctl: ${refusal}`);
      process.exit(1);
    }
  }
  const takeover = await preflightTakeover({
    configPath,
    killOthers: opts.killOthers,
    apiPortOverride: getLoadedConfig()?.apiPort,
  });
  if (!takeover.ok) {
    console.error(takeover.message);
    process.exit(1);
  }

  if (opts.headless) {
    // Never saved: only the picker saves the selection.
    const session = new Session({
      plan: buildSessionPlan(plainNames ?? []),
      configPath,
      logFile,
      forked,
    });
    // A forked session's output is in its log; its parent has no screen to stream it to.
    await runHeadless(session, { echo: !forked });
    return;
  }

  // --ui (default): App (`tui/App.tsx`) shows the picker, unless `-s` or `--last-answers` already
  // name the services, then the run screen, whose session starts the control server and the
  // rest. Only the picker saves the selection. Loaded via renderAppInProduction so React (and
  // thus all of Ink) runs in its production build — its development build leaks User-Timing
  // entries on every render (see render-app-production.ts). Child dev processes still inherit
  // the shell's NODE_ENV.
  await renderAppInProduction({
    packages: opts.service,
    lastAnswers: opts.lastAnswers,
    logFile,
    configPath,
  });
}
