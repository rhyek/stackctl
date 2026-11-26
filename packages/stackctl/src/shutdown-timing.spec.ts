import { expect, test } from 'vitest';
import {
  HANDOFF_FORCE_KILL_MS,
  QUIT_REQUEST_TIMEOUT_MS,
  SERVICE_STOP_REQUEST_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_TIMEOUT_MS,
  STOP_HOOK_BUDGET_MS,
  STOP_SWEEP_MARGIN_MS,
} from './shutdown-timing';

// What the clients of a quit rely on: a session whose stop hooks take all the time they have, and
// whose services take their whole grace, is still within what `stackctl stop` and a takeover
// allow it.

test('the shutdown a client waits for covers both stop-hook steps and the whole stop', () => {
  expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(
    2 * STOP_HOOK_BUDGET_MS + SHUTDOWN_GRACE_MS + STOP_SWEEP_MARGIN_MS,
  );
});

test('stackctl stop waits for longer than the shutdown may take before saying the session did not answer', () => {
  expect(QUIT_REQUEST_TIMEOUT_MS).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
});

test('a takeover force-kills the session it replaces only after its whole graceful shutdown', () => {
  expect(HANDOFF_FORCE_KILL_MS).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
});

test("the control client's default wait for a service stop covers the whole grace", () => {
  expect(SERVICE_STOP_REQUEST_TIMEOUT_MS).toBeGreaterThan(SHUTDOWN_GRACE_MS);
});
