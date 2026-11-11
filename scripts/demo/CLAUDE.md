# scripts/demo — the demo GIF

Everything here exists to produce one file: `docs/public/demo-<unix-ts>.gif`, the recording
under the hero of the site's home page (`docs/index.md`) and at the top of the root `README.md`.
It is internal tooling — nothing in it belongs in the user-facing docs.

| file        | role                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `record.sh` | the entry point: renders the tape, downscales/crops, renames, fixes the links |
| `demo.tape` | the VHS script — the keystrokes and pacing of the demo                     |
| `click.exp` | an expect wrapper that injects the one mouse event VHS cannot send         |
| `frames.ts` | frame-by-frame inspection of a finished GIF (see **Debugging**)            |

## Recording

```sh
./scripts/demo/record.sh          # from anywhere; checks every take itself
node scripts/demo/frames.ts       # to look at the frames of the GIF it kept
```

**A take is published only if it passes.** The capture can't be made identical run to run (VHS
photographs a live app from headless Chromium), so `record.sh` checks each take and records up to
`MAX_TAKES` (3) until one passes: the double-click copied `Added` (the clipboard says so), and
`frames.ts` exits 0 (no half-painted footer, no frame below 40% of its neighbours' text). Before
each take it waits for the load average to drop to `MAX_LOAD` (twice the cores). If no take
passes, it exits 1 and the previous GIF and links stay as they are.

Needs `brew install vhs ttyd ffmpeg`, and Docker for the example's infra; `expect` ships with
macOS. It drives the **real** example workspace, so `cd example && pnpm stackctl` must boot
cleanly first.

Worth knowing before you run it:

- **It needs ports 3000–3002 and 21050 free**, and stops, naming the process, if one is held.
  It never kills anything.
- **It brings the example's infra up** (`stackctl infra up`) and leaves it running.
- **It uses the system clipboard.** The clipboard's text is put back at the end; an image or a
  file on it is lost.
- **It rewrites two links** to the new filename: the image line of the root `README.md` and
  `demo.src` in `docs/index.md` (failing loudly if either stops matching), and deletes the
  previous GIF. The timestamp suffix is cache-busting — GitHub and npm serve the old image
  forever otherwise.

## How the recording works

VHS runs the tape against `ttyd` inside a **headless Chromium**, screenshotting the terminal.
The tape's first hidden act is `exec expect -f click.exp`, so everything visible afterwards —
including the typed `pnpm stackctl` — really runs, just with a transparent byte relay in the
middle.

### The double-click is injected, because VHS has no mouse

VHS can only send keystrokes. Its `Copy`/`Paste` push text one rune at a time, so they can't
deliver an escape sequence as a single chunk either, and connecting a second client to `ttyd`
spawns a fresh shell rather than attaching to the recorded one. So `click.exp` writes a real
SGR mouse report (`ESC[<0;col;rowM` / `…m`, twice) straight into stackctl's stdin. It has to be
**one write**: stackctl parses each stdin chunk on its own, and the two presses must land inside
`DOUBLE_CLICK_MS` (300ms, `word-select.ts`) to read as a double-click rather than two clicks.

What the GIF shows is therefore genuine: stackctl's own word selection, its
`✓ copied 5 chars to clipboard` notice, and the word really on the system clipboard — which is
what the tape then pastes into the filter, since VHS's `Paste` reads the system clipboard.
`record.sh` seeds that clipboard with `added` beforehand so that a click which ever misses
degrades to the old demo instead of pasting the machine's real clipboard into a public GIF.

### Coordinates

Neither is measured off pixels:

- **The column is read off stackctl's output.** Once the command finishes, `click.exp` finds the
  backend's last `Added todo` line in the session's logfile, whose label is padded by the same
  function as the screen's, and aims two cells into `Added`. A longer name in the example moves
  the word and the click with it.
- **Row `rows-9`** — the footer is 5 rows in normal mode, so the newest log line is on `rows-5`.
  Four rows above that is inside the five `Added todo:` lines whether nothing has arrived since
  the command finished or the worker's three-line heartbeat has.

The terminal is **35 rows x 111 columns**, which falls out of the tape's `Set` block. To
re-derive it after changing `Width`/`Height`/`FontSize`/`Padding`, render a throwaway tape with
the same block that runs `stty size > /tmp/size.txt`. Those same numbers back the `crop=` values
in `record.sh`.

## The strokes are thinned to match a terminal

Chrome draws the terminal on a canvas with macOS font smoothing, which thickens every stroke;
kitty and most terminals draw Menlo without it. VHS starts the system Chrome itself, so there is
no flag to turn it off. Instead `record.sh` runs ffmpeg's `erosion` on the 2x render, capped at 48
per channel, before the downscale: it takes in each stroke's anti-aliased edge and leaves its
solid middle (its color) alone, so bold still reads bold. Above ~64 the dim grays start to fade.

## Two rules that keep the recording clean

Both were learned by breaking them, and both produce the same symptom: a frame showing the top
of the screen redrawn and everything below it — footer included — still blank.

1. **Never `sleep` inside `click.exp`.** While expect sleeps it stops draining the pty, so
   stackctl's repaint sits in the pipe and the recording freezes mid-paint. The beat before the
   click is `expect timeout`, which keeps reading (and, with `log_user` on, echoing) for the
   whole beat. Measured against a child printing every 100ms: `expect timeout` relays at that
   same cadence, `sleep 2` opens a 2.0s hole.
2. **Use `-ex`, never `-re`, for interact patterns.** A regexp makes `interact` rescan its buffer
   per chunk. Measured relay time for a 32KB repaint: **0.3–0.5ms** with no wrapper, **1.0–1.3ms**
   through plain `interact` or `-ex`, and **8–14ms** with `-re` — wide enough for the recorder to
   photograph a half-applied repaint.

stackctl itself is not the source of these frames: its output stream contains no screen-clear
sequences at all (no `ED`, no cursor-home), only incremental repaints.

## Debugging

**`node scripts/demo/frames.ts [gif]`** (defaults to the newest `demo-*.gif`) writes every frame
to `.frames/` and reports two things: runs where the bottom quarter has no text _inside the run
phase_ (a half-applied repaint — it calibrates the run phase from the recording itself, so no
frame numbers are hardcoded), and frames carrying much less text than their neighbours. That
second scale is calibrated against real takes: **~30%** of normal is a repaint artefact, **~50%**
is the filter applying or clearing (a real content change), above **70%** is ordinary scrolling.
Each finding prints the PNG path, so the next step is always to open that frame.

Two blank stretches are **normal** and reported as bookends, not findings: stackctl entering the
alternate screen at startup (before its first paint) and leaving it after `^C`.

**Rehearsing without VHS.** A record cycle is ~2 minutes; the choreography can be rehearsed in
seconds in a detached tmux pane (`tmux new-session -d -x 111 -y 35`, `send-keys`,
`capture-pane -p` for the rendered screen), or through a PTY — see the `testing-behavior-with-pty` skill, driving
`expect -f click.exp` at 35x111 and asserting on `pbpaste`. Two gotchas that cost time:

- The child needs a **controlling terminal** (`TIOCSCTTY`) or `interact` can't put its stdin in
  raw mode and echoes everything — which is not how it behaves under ttyd.
- Reset the remembered selection (`pnpm stackctl --mode development reset`) first, exactly as the tape's
  hidden block does, or the picker starts pre-selected and every subsequent keystroke lands
  somewhere else.

**When a take goes wrong.** Two failure modes, both stochastic, so re-recording is a legitimate
fix — but check every take before keeping it.

- **Half-painted frames track machine load.** Headless Chromium has to keep up with the repaints;
  it can't when the machine is busy. A take recorded at load ~150 came back with seven of them,
  and the same tape at load ~20 recorded clean. `record.sh` waits for the load, and drops a take
  `frames.ts` fails.
- **The click lands on the wrong line** when the worker's heartbeat interleaves with the todos and
  shifts the rows, which shows up as a different word in the notice and in the filter.
  `record.sh` drops a take whose clipboard doesn't read `Added`.
