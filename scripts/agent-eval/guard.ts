#!/usr/bin/env node
// The eval's PreToolUse hook for Bash: runs a command only when every part of it reads and
// nothing in it can change the machine, and refuses everything else. An agent under test is
// asked to restart, stop and reset things, so the session it works against has to survive every
// run unchanged, and other projects' sessions on this machine must never be reachable. The
// refused command still appears in the transcript, which is what the graders read.
//
//   echo '{"tool_input":{"command":"pnpm stackctl status"}}' | node guard.ts
import { readFileSync } from 'node:fs';

/** Splits on `;`, `&&`, `||`, `|` and newlines outside quotes; `null` when it can't be read safely. */
export function segments(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote) {
      // inside double quotes a substitution still runs
      if (quote === '"' && (c === '`' || (c === '$' && next === '('))) {
        return null;
      }
      if (c === '\\' && quote === '"') {
        cur += c + (next ?? '');
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '`' || (c === '$' && next === '(') || (c === '<' && next === '(')) {
      return null;
    } else if (c === '\\') {
      cur += c + (next ?? '');
      i++;
    } else if (c === ';' || c === '\n' || c === '(' || c === ')') {
      // a subshell's parentheses only group: what is inside is checked like the rest
      out.push(cur);
      cur = '';
    } else if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      out.push(cur);
      cur = '';
      i++;
    } else if (c === '|') {
      out.push(cur);
      cur = '';
    } else if (c === '&') {
      // `2>&1` and `&>/dev/null` are redirections; a lone `&` backgrounds
      if (command[i - 1] === '>' || next === '>') {
        cur += c;
      } else {
        return null;
      }
    } else {
      cur += c;
    }
  }
  if (quote) {
    return null;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The segment with the redirections that write nothing removed; `null` when it writes a file. */
function withoutHarmlessRedirections(segment: string): string | null {
  const stripped = segment
    .replaceAll(/\s*(?:[12]?>>?|&>)\s*\/dev\/null/g, '')
    .replaceAll(/\s*2>&1/g, '')
    .replaceAll(/\s*<\s*\/dev\/null/g, '');
  // what is left of `<` or `>` outside quotes is a real redirection or a heredoc
  const unquoted = stripped.replaceAll(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  return /[<>]/.test(unquoted) ? null : stripped.trim();
}

const READERS =
  /^(cat|head|tail|wc|ls|file|stat|grep|egrep|fgrep|rg|jq|sort|uniq|cut|tr|column|nl|basename|dirname|realpath|readlink|diff|tree|pwd|true|false|echo|printf|date|which|type|test|\[|\[\[|read|ps|pgrep|lsof|netstat|uname|whoami|id|uptime|hostname|sw_vers|df|du|shasum|md5|nc -z|command -v)(\s|$)/;
const COMPOSE_READS = '(ps|ls|logs|config|top|images|port|version|events)';
const LOCAL_URL =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)(:(\d+|\$\{?\w+\}?))?(\/|$|\?)/;

function words(segment: string): string[] {
  return (segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? []).map((w) =>
    /^(['"]).*\1$/s.test(w) ? w.slice(1, -1) : w,
  );
}

function curlReads(segment: string): boolean {
  const args = words(segment).slice(1);
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^(-X|--request)$/.test(a)) {
      if ((args[i + 1] ?? '').toUpperCase() !== 'GET') {
        return false;
      }
      i++;
    } else if (a.startsWith('-X')) {
      if (a.slice(2).toUpperCase() !== 'GET') {
        return false;
      }
    } else if (/^(-o|--output)$/.test(a)) {
      if (args[i + 1] !== '/dev/null') {
        return false;
      }
      i++;
    } else if (
      /^(-d|--data|--data-\w+|--json|-F|--form|-T|--upload-file|-O|--remote-name|-K|--config)/.test(
        a,
      )
    ) {
      return false;
    } else if (
      /^(-m|--max-time|--connect-timeout|-w|--write-out|-H|--header|-A|--user-agent|--retry|--retry-delay|--retry-max-time)$/.test(
        a,
      )
    ) {
      i++;
    } else if (/^-[^-]/.test(a)) {
      // a bundle of short flags (`-sS`, `-so /dev/null`) may not hide one that writes or sends
      const letters = a.slice(1);
      if (/[dFTOXK]/.test(letters)) {
        return false;
      }
      if (letters.includes('o')) {
        if (!letters.endsWith('o') || args[i + 1] !== '/dev/null') {
          return false;
        }
        i++;
      } else if (/[mwHA]$/.test(letters)) {
        i++;
      }
    } else if (a.startsWith('--')) {
      // any other long flag takes no value that matters here
    } else {
      if (!LOCAL_URL.test(/^https?:\/\//.test(a) ? a : `http://${a}`)) {
        return false;
      }
      urls++;
    }
  }
  return urls > 0;
}

function stackctlReads(args: string[]): boolean {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--mode' || a === '-m') {
      i++;
    } else if (!a.startsWith('--mode=')) {
      rest.push(a);
    }
  }
  if (rest.some((a) => a === '--help' || a === '-h') || rest[0] === 'help') {
    return true;
  }
  const [cmd, sub, third] = rest;
  if (cmd === '--version' || cmd === '-V' || cmd === '-v') {
    return true;
  }
  if (cmd === 'status' || cmd === 'show-config' || cmd === 'events' || cmd === 'logs') {
    return true;
  }
  return (
    cmd === 'infra' &&
    (sub === 'docker-compose' || sub === 'compose') &&
    new RegExp(`^${COMPOSE_READS}$`).test(third ?? '')
  );
}

/** Whether one segment only reads. */
export function reads(raw: string): boolean {
  const cleaned = withoutHarmlessRedirections(raw);
  if (cleaned === null) {
    return false;
  }
  // what only steers the shell decides nothing: a loop's head and end, a group's braces, a
  // condition's keywords. What they run is still checked.
  let segment = cleaned;
  for (let before = ''; before !== segment;) {
    before = segment;
    segment = segment
      .replace(/^(?:do|then|else|elif|if|while|until|time|!|\{)\s+/, '')
      .replace(/\s*\}$/, '')
      // a leading `NAME=value` changes nothing outside the command
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  }
  if (
    /^(?:done|fi|\{|\}|)$/.test(segment) ||
    /^for\s+\w+\s+in(\s|$)/.test(segment) ||
    /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(segment)
  ) {
    return true;
  }
  const w = words(segment);
  const [head] = w;
  if (head === undefined) {
    return true;
  }
  if (head === 'cd') {
    return w.length <= 2;
  }
  if (head === 'sh' || head === 'bash' || head === 'zsh') {
    // `sh -c '<command>'` reads when its command does
    return w.length === 3 && w[1] === '-c' && allowed(w[2]!);
  }
  if (head === 'xargs') {
    // what xargs runs, once its own flags and their values are passed over
    let at = 1;
    while (at < w.length && w[at]!.startsWith('-')) {
      at += /^-[IJnPLsER]$/.test(w[at]!) ? 2 : 1;
    }
    const rest = segment.slice(segment.indexOf(w[at] ?? '\0'));
    return at < w.length && w[at] !== 'xargs' && segment.includes(w[at]!) && reads(/^(sh|bash|zsh)$/.test(w[at]!) ? w.slice(at).map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ') : rest); // oxfmt-ignore
  }
  if (head === 'sleep') {
    return Number(w[1]) <= 30;
  }
  if (head === 'find') {
    return !w.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a));
  }
  if (head === 'sed') {
    // prints to stdout unless told to edit in place, or its script writes a file (`w`)
    return !w.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || /(^|[;}/])\s*w\s+\S/.test(a)); // oxfmt-ignore
  }
  if (head === 'node' && w.length === 3 && /^(-e|-p|--eval|--print)$/.test(w[1]!)) {
    // a filter over stdin, as an agent without jq writes one: nothing that reaches outside it
    return !/require|import|child_process|\bfs\b|spawn|exec|kill|fetch|http|\bnet\b|write|unlink|\brm\b|process\.(?!stdin|stdout|argv|exit)/.test(w[2]!); // oxfmt-ignore
  }
  if (/^python3?$/.test(head) && w.length === 3 && w[1] === '-c') {
    return !/\bimport\s+(?!json\b|sys\b|re\b)|\bopen\(|\bos\.|subprocess|shutil|socket|urllib|exec\(|eval\(/.test(w[2]!) && !/import\s+[\w, ]*\b(os|subprocess|shutil|socket|urllib|pathlib)\b/.test(w[2]!); // oxfmt-ignore
  }
  if (head === 'awk') {
    return !/system\s*\(|getline|\bprint\s*>|\|\s*"/.test(segment);
  }
  if (head === 'curl') {
    return curlReads(segment);
  }
  if (head === 'env' || head === 'printenv' || head === 'export' || head === 'set') {
    return false; // would print the token the run is given
  }
  if (head === 'docker') {
    if (w[1] === 'compose') {
      const sub = w
        .slice(2)
        .find(
          (a, i, all) =>
            !a.startsWith('-') &&
            !/^(-f|-p|--file|--project-name|--project-directory|--env-file|--profile|--ansi)$/.test(
              all[i - 1] ?? '',
            ),
        );
      return new RegExp(`^${COMPOSE_READS}$`).test(sub ?? '');
    }
    if (w[1] === 'events') {
      return w.includes('--until'); // without an end it follows forever
    }
    return (
      /^(ps|images|inspect|logs|port|top|version|info|stats)$/.test(w[1] ?? '') ||
      (/^(volume|network|container|image|context)$/.test(w[1] ?? '') &&
        /^(ls|inspect)$/.test(w[2] ?? ''))
    );
  }
  if (head === 'docker-compose') {
    const sub = w.slice(1).find((a) => !a.startsWith('-'));
    return new RegExp(`^${COMPOSE_READS}$`).test(sub ?? '');
  }
  if (head === 'brew') {
    return (
      /^(list|info|--version)$/.test(w[1] ?? '') ||
      (w[1] === 'services' && /^(list|info)?$/.test(w[2] ?? ''))
    );
  }
  if (head === 'launchctl') {
    return /^(list|print)$/.test(w[1] ?? '');
  }
  if (head === 'git') {
    return /^(status|log|diff|branch|rev-parse|show|remote|ls-files)$/.test(w[1] ?? '');
  }
  if (head === 'node' || head === 'go' || head === 'pnpm' || head === 'npm' || head === 'npx') {
    if (w.length === 2 && /^(-v|--version|version)$/.test(w[1]!)) {
      return true;
    }
  }
  if (
    head === 'stackctl' ||
    head === 'sctl' ||
    /(^|\/)node_modules\/\.bin\/(stackctl|sctl)$/.test(head)
  ) {
    return stackctlReads(w.slice(1));
  }
  if (head === 'node' && /(^|\/)stackctl\/dist\/cli\.js$/.test(w[1] ?? '')) {
    return stackctlReads(w.slice(2)); // the CLI run by its file
  }
  if (head === 'npx' || head === 'bunx' || head === 'yarn') {
    return (w[1] === 'stackctl' || w[1] === 'sctl') && stackctlReads(w.slice(2));
  }
  if (head === 'pnpm') {
    const at = w[1] === 'exec' || w[1] === '-s' || w[1] === '--silent' ? 2 : 1;
    if (w[at] === 'stackctl' || w[at] === 'sctl') {
      return stackctlReads(w.slice(at + 1));
    }
    return /^(list|ls|why|root|bin)$/.test(w[1] ?? '');
  }
  return READERS.test(segment);
}

/**
 * The command with each `$(…)` and backtick substitution replaced by a placeholder, once what
 * it runs is known to read; `null` when one of them doesn't, or can't be followed.
 */
function withoutSubstitutions(command: string): string | null {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      quote = c === "'" ? null : quote;
      out += c;
      continue;
    }
    if (c === '\\') {
      out += c + (command[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      quote = quote ? null : '"';
      out += c;
    } else if (c === "'" && !quote) {
      quote = "'";
      out += c;
    } else if (c === '$' && command.startsWith('((', i + 1)) {
      const end = command.indexOf('))', i);
      if (end === -1) {
        return null;
      }
      out += '0'; // arithmetic runs nothing
      i = end + 1;
    } else if ((c === '$' || c === '<') && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let inner: "'" | '"' | null = null;
      for (; j < command.length && depth > 0; j++) {
        const d = command[j]!;
        if (inner) {
          inner = d === inner ? null : inner;
        } else if (d === "'" || d === '"') {
          inner = d;
        } else if (d === '(') {
          depth++;
        } else if (d === ')') {
          depth--;
        }
      }
      if (depth > 0 || !allowed(command.slice(i + 2, j - 1))) {
        return null;
      }
      out += 'SUBSTITUTED';
      i = j - 1;
    } else if (c === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1 || !allowed(command.slice(i + 1, end))) {
        return null;
      }
      out += 'SUBSTITUTED';
      i = end;
    } else {
      out += c;
    }
  }
  return out;
}

/** Whether the whole command only reads. */
export function allowed(command: string): boolean {
  const plain = withoutSubstitutions(command);
  const parts = plain === null ? null : segments(plain);
  return parts !== null && parts.every(reads);
}

/**
 * Whether one segment may run in the end-to-end check, where commands take effect: one that
 * reads, anything through stackctl, or the project's own test script. A `kill`, a service
 * started by hand and every docker command that changes something stay refused: they would
 * reach past the session, or leave a process stackctl doesn't own.
 */
function acts(raw: string): boolean {
  // output kept in a scratch file is how an agent backgrounds a command
  const segment = raw
    .replaceAll(/\s*(?:[12]?>>?|&>)\s*\/tmp\/[\w./-]+/g, '')
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    .replace(/^nohup\s+/, '')
    .trim();
  if (reads(segment)) {
    return true;
  }
  if (withoutHarmlessRedirections(segment) === null) {
    return false;
  }
  const w = words(segment);
  const [head] = w;
  if (head === 'wait' || (head === 'sleep' && Number(w[1]) <= 180)) {
    return true;
  }
  if (head === 'stackctl' || /(^|\/)node_modules\/\.bin\/stackctl$/.test(head ?? '')) {
    return true;
  }
  if (head === 'npx') {
    return w[1] === 'stackctl';
  }
  if (head === 'node') {
    return w[1] === '--test';
  }
  if (head === 'pnpm') {
    let at = 1;
    while (/^(--filter|-F|-C|--dir)$/.test(w[at] ?? '')) {
      at += 2;
    }
    at += w[at] === 'exec' || w[at] === 'run' ? 1 : 0;
    // the root `dev` script is stackctl itself, which refuses to take a person's session over
    return /^(stackctl|test)$/.test(w[at] ?? '') || (at === 1 && w[1] === 'dev');
  }
  return false;
}

/** Whether the whole command may run in the end-to-end check. */
export function allowedToAct(command: string): boolean {
  const plain = withoutSubstitutions(command);
  // a lone `&` backgrounds what is before it: the same commands, checked the same way
  const parts = plain === null ? null : segments(plain.replaceAll(/(?<![>&|])&(?![>&])/g, ';'));
  if (parts === null) {
    return false;
  }
  // after a `cd`, `pnpm dev` is some service's own dev script, not the root's
  const moved = parts.some((part) => /^cd\s/.test(part));
  return parts.every((part) => acts(part) && !(moved && /\bpnpm\s+(?:run\s+)?dev\b/.test(part)));
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { tool_input?: { command?: string } };
  const command = input.tool_input?.command ?? '';
  const ok = process.env.AGENT_EVAL_ACT ? allowedToAct(command) : allowed(command);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: ok ? 'allow' : 'deny',
        permissionDecisionReason: ok
          ? 'allowed by the eval'
          : 'Permission to run this command was denied.',
      },
    }),
  );
}
