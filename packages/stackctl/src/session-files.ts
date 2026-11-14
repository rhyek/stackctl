import fs from 'node:fs';
import path from 'node:path';
import { profileStateDir } from './log-files.js';
import { isProcessAlive } from './process-info.js';
import { readRunning } from './running.js';

// Each session's own folder, `node_modules/.stackctl/profiles/<profile>/sessions/<id>/`: its log
// (`logs.txt`), its event log (`events.jsonl`) and the logs of the one-off commands run while it
// was the profile's latest (`commands/`). The id is when the session started, in ms since the
// epoch, so the folders sort by age. A folder covers its session and what came after it, until the
// next one starts: a command run with no session running writes to the newest folder.

/** How long a session's folder is kept: one older than this is deleted when a session starts. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A session id, as this stackctl makes them: a start time in ms. An older stackctl's was a UUID. */
export const isSessionId = (id: string): boolean => /^\d+$/.test(id);

/** The profile's session folders' parent. Not created. */
export function sessionsDir(root: string, profile: string): string {
  return path.join(profileStateDir(root, profile), 'sessions');
}

/** A session's folder. Not created. */
export function sessionDirOf(root: string, profile: string, id: string): string {
  return path.join(sessionsDir(root, profile), id);
}

/** A session's log. */
export function sessionLogPath(root: string, profile: string, id: string): string {
  return path.join(sessionDirOf(root, profile, id), 'logs.txt');
}

/** A session's event log. */
export function sessionEventsPath(root: string, profile: string, id: string): string {
  return path.join(sessionDirOf(root, profile, id), 'events.jsonl');
}

/** Where the one-off commands run in a session's time write their logs. */
export function sessionCommandsDir(root: string, profile: string, id: string): string {
  return path.join(sessionDirOf(root, profile, id), 'commands');
}

/** The ids of the profile's session folders, oldest first. */
function sessionIds(root: string, profile: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir(root, profile), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSessionId(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** The latest session's id, `null` with none. */
export function newestSessionId(root: string, profile: string): string | null {
  return sessionIds(root, profile).at(-1) ?? null;
}

/**
 * The session `logs`, `events` and `status` show: the profile's running session, else the latest
 * one. A running session an older stackctl started has no folder; the latest folder stands in.
 */
export function currentSessionId(root: string, profile: string): string | null {
  const running = readRunning(root, profile);
  if (
    running?.sessionId !== undefined &&
    isSessionId(running.sessionId) &&
    isProcessAlive(running.pid)
  ) {
    return running.sessionId;
  }
  return newestSessionId(root, profile);
}

/**
 * The session a command's lines and log go to: the current one, or, before any session ever ran
 * here, a folder of its own, named by the time, as a session's would be.
 */
export function writeTargetSessionId(root: string, profile: string, now = Date.now()): string {
  return currentSessionId(root, profile) ?? String(now);
}

/** Where a one-off command run now writes its log: the `commands/` of the session it belongs to. */
export function oneOffLogDir(root: string, profile: string): string {
  return sessionCommandsDir(root, profile, writeTargetSessionId(root, profile));
}

/**
 * Deletes the profile's session folders older than {@link SESSION_RETENTION_MS}, never `keep`'s,
 * and what an older stackctl kept beside the profile's state (`logs/`, `events.log`,
 * `events.1.log`). A starting session calls it once the session it replaces has ended.
 */
export function pruneSessions(root: string, profile: string, keep: string, now = Date.now()): void {
  for (const id of sessionIds(root, profile)) {
    if (id !== keep && Number(id) < now - SESSION_RETENTION_MS) {
      fs.rmSync(sessionDirOf(root, profile, id), { recursive: true, force: true });
    }
  }
  const profileDir = profileStateDir(root, profile);
  for (const legacy of ['logs', 'events.log', 'events.1.log']) {
    fs.rmSync(path.join(profileDir, legacy), { recursive: true, force: true });
  }
}
