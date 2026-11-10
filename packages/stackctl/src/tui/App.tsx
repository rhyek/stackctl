import path from 'node:path';
import React, { useCallback, useEffect, useState } from 'react';
import chalk from 'chalk';
import { render, useApp } from 'ink';
import { initialPhaseFor, saveSelection } from '../saved-selection.js';
import { buildSessionPlan } from '../session/plan.js';
import { Session } from '../session/session.js';
import { installShutdownSignals } from '../signals.js';
import { setTitleSequence } from '../terminal-title.js';
import { type Shell, crashRestore, failWith, finish } from './app-exit.js';
import { planRuns, pickerInputOf } from './picker-input.js';
import type { PickerInput } from './picker-state.js';
import { Picker } from './Picker.js';
import { RunScreen } from './RunScreen.js';
import { installTerminalRestore } from './shutdown.js';

// The app shell: the picker, then the run screen over a `Session`, in one Ink instance in the
// alternate screen, from mount to exit. `renderApp` pins the tab title, writes the start line,
// mounts, and once Ink has unmounted writes the exit line and exits the process.

export interface RenderAppOptions {
  /** `-s` names: the session starts with them, with no picker. */
  packages?: string[];
  /** `--last-answers`: a usable saved selection starts the session with no picker. */
  lastAnswers?: boolean;
  /** The session's logfile. */
  logFile: string;
  /** The config file's path, which the session record names. */
  configPath: string;
}

function newSession(names: string[], logFile: string, configPath: string): Session {
  return new Session({
    plan: buildSessionPlan(names),
    configPath,
    logFile,
    forked: false,
    interactive: true,
  });
}

interface AppProps {
  /** The session from the start, for `-s` and `--last-answers`; `null` shows the picker. */
  initial: Session | null;
  /** The picker's input, when the picker is the first screen. */
  picker: PickerInput | null;
  /** Makes the session for the picks, and keeps it for the exit. */
  open: (names: string[]) => Session;
  /** Keeps why no session could be made, for the exit. */
  fail: (err: unknown) => void;
}

function App({ initial, picker, open, fail }: AppProps): React.ReactElement | null {
  const { exit } = useApp();
  const [session, setSession] = useState(initial);

  // While the picker is up a signal leaves it as Ctrl+C does: no session exists to shut down yet.
  // Removed in the commit that mounts the run screen, before its session installs its own.
  useEffect(() => (session ? undefined : installShutdownSignals(() => exit())), [session, exit]);

  const start = useCallback(
    (names: string[]) => {
      try {
        setSession(open(names));
      } catch (err) {
        fail(err);
        exit();
      }
    },
    [open, fail, exit],
  );

  if (session) {
    return <RunScreen session={session} />;
  }
  if (!picker) {
    return null;
  }
  // A failed save is logged by the picker and never blocks the start (picker §8.2).
  return (
    <Picker input={picker} plan={planRuns} onSave={saveSelection} onStart={start} onExit={exit} />
  );
}

/**
 * Mounts the app: the run screen at once for `-s` names or a usable `--last-answers`, the picker
 * otherwise, with the last selection preselected. Ends by exiting the process.
 */
export function renderApp(options: RenderAppOptions): void {
  const startedAt = Date.now();
  const { logFile, configPath } = options;
  const shell: Shell = { session: null, failure: null };
  let picker: PickerInput | null = null;
  let session: Session | null = null;
  try {
    const phase = initialPhaseFor({
      packages: options.packages ?? [],
      lastAnswers: options.lastAnswers ?? false,
    });
    if (phase.type === 'run') {
      session = newSession(phase.services, logFile, configPath);
      shell.session = session;
    } else {
      picker = pickerInputOf(phase.preselected);
    }
  } catch (err) {
    void failWith(err);
    return;
  }

  if (process.stdout.isTTY) {
    process.stdout.write(setTitleSequence(`stackctl: ${path.basename(process.cwd())}`));
  }
  process.stdout.write(`${chalk.green('▶')} ${chalk.bold('stackctl')} ${chalk.dim('started')}\n`);

  const removeRestore = installTerminalRestore();
  const instance = render(
    <App
      initial={session}
      picker={picker}
      open={(names) => {
        // One session only, however many starts reach here before the run screen commits.
        session ??= newSession(names, logFile, configPath);
        shell.session = session;
        return session;
      }}
      fail={(err) => {
        shell.failure = err;
      }}
    />,
    {
      exitOnCtrlC: false,
      maxFps: 120,
      alternateScreen: true,
      kittyKeyboard: { mode: 'disabled' },
    },
  );
  // A fatal uncaught error: Ink unmounts first, so Node prints the error on the primary screen.
  const onCrash = crashRestore(() => instance.unmount(), removeRestore);
  process.on('uncaughtExceptionMonitor', onCrash);
  void instance
    .waitUntilExit()
    .then(
      () => null,
      (err: unknown) => err ?? new Error('the screen failed to render'),
    )
    .then((crash) => {
      process.off('uncaughtExceptionMonitor', onCrash);
      // Ink has left the alternate screen; leaving it again would move the cursor over the exit line.
      removeRestore();
      return finish(shell, crash, startedAt);
    });
}
