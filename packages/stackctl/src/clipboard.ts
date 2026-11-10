/**
 * Best-effort clipboard writes for the TUI's copy action. Two mechanisms, chosen
 * by where the session runs:
 *
 * 1. **A native clipboard command** (`pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`) —
 *    rock-solid **locally**, and — unlike OSC 52 — it never trips a terminal's
 *    clipboard-access prompt (e.g. iTerm2's "Applications in terminal may access
 *    clipboard"). Useless over SSH, where it would set the *remote* box's
 *    clipboard.
 * 2. **OSC 52** — an escape sequence the terminal itself interprets to set the
 *    system clipboard. It travels over SSH to the user's **local** terminal, so
 *    it's used there; locally it's only a fallback for when no native binary
 *    exists (precisely to avoid the permission prompt when we don't need it).
 */
import { Buffer } from 'node:buffer';
import { execa } from 'execa';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * Some terminals choke on very large OSC 52 payloads (and there are historical
 * escape-length caps), so skip the OSC 52 path past this many base64 chars and
 * rely on the native command instead.
 */
const OSC52_MAX_BASE64 = 100_000;

/** The OSC 52 clipboard-set sequence for `text`, or null when it's too large to send safely. */
export function osc52(text: string): string | null {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  if (base64.length > OSC52_MAX_BASE64) {
    return null;
  }
  return `${ESC}]52;c;${base64}${BEL}`;
}

/** Ordered native clipboard commands to try for the current platform. */
function nativeClipboardCommands(): [string, string[]][] {
  switch (process.platform) {
    case 'darwin':
      return [['pbcopy', []]];
    case 'win32':
      return [['clip', []]];
    default:
      // Linux/BSD: Wayland first, then X11 fallbacks. First one present wins.
      return [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
      ];
  }
}

async function copyViaNativeCommand(text: string): Promise<boolean> {
  for (const [cmd, args] of nativeClipboardCommands()) {
    try {
      await execa(cmd, args, { input: text });
      return true;
    } catch {
      // Binary missing or failed — try the next candidate.
    }
  }
  return false;
}

/** Whether the session looks like it's over SSH (a native clipboard binary would target the remote host). */
function isRemoteSession(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

/**
 * Copy `text` to the system clipboard, best-effort and non-blocking. Never throws.
 *
 * Locally, uses the native clipboard command only (no OSC 52, so no terminal
 * clipboard-access prompt), falling back to OSC 52 (via `write`, default stdout)
 * only if no native binary is available. Over SSH, uses OSC 52 directly, since
 * that's what reaches the user's local terminal.
 */
export function copyToClipboard(
  text: string,
  write: (data: string) => void = (data) => void process.stdout.write(data),
): void {
  if (text.length === 0) {
    return;
  }
  const writeOsc52 = () => {
    const sequence = osc52(text);
    if (sequence) {
      write(sequence);
    }
  };
  if (isRemoteSession()) {
    writeOsc52();
    return;
  }
  void copyViaNativeCommand(text).then((ok) => {
    if (!ok) {
      writeOsc52();
    }
  });
}
