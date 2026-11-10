/**
 * Terminal window/tab title control for the fullscreen TUI.
 *
 * The TUI pins the tab to a stable `stackctl: <project>` title. Child dev
 * processes freely emit their own OSC title-setting sequences — a shell echoing
 * the command it's about to run, a build tool announcing progress — and because
 * their output is *captured* and re-rendered into the log viewport (rather than
 * flowing straight to the terminal), those sequences would otherwise reach the
 * real terminal and make the tab flicker between whatever each child last set.
 * {@link stripTitleSequences} removes them from captured output so only our
 * title survives; {@link setTitleSequence} produces the one we write on mount.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** OSC 0 sets both the icon (tab) name and the window title. */
export function setTitleSequence(title: string): string {
  return `${ESC}]0;${title}${BEL}`;
}

/**
 * OSC 0/1/2 title-setting sequences: `ESC ] {0,1,2} ; text (BEL | ST)`, which
 * set the icon name, the window title, or both. Terminated by either BEL
 * (`\x07`) or ST (`ESC \`). The text run stops before either terminator byte,
 * so SGR color codes and every other escape in the stream are left intact.
 * Built from the {@link ESC}/{@link BEL} constants (rather than a regex literal
 * with raw control bytes) so the control characters stay readable and out of the
 * linter's way.
 */
const TITLE_OSC = new RegExp(`${ESC}\\][012];[^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');

/** Strip terminal title-setting sequences from a chunk of captured child output. */
export function stripTitleSequences(text: string): string {
  return text.includes(`${ESC}]`) ? text.replace(TITLE_OSC, '') : text;
}
