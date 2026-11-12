# maintenance/scripts/demo — the docs' terminal recordings

Everything here exists to produce the recordings of stackctl's terminal UI that the docs show:

- **`docs/public/casts/<scene>-<unix-ts>.cast`**, one asciicast per scene, played as text by
  asciinema-player (`docs/.vitepress/theme/TerminalPlayer.vue`): native Menlo, sharp at any zoom,
  selectable. The home page's demo (`demo.src` in `docs/index.md`), the terminal UI guide's
  picker and run screen, and getting started's screenshot of a first run.
- **The text copy beside each player in a page**, the screen it shows as plain text, which
  llms.txt and the packaged docs read instead of the player.
- **`docs/public/demo-<unix-ts>.gif`**, agg's render of the demo's cast, at the top of the root
  `README.md`: GitHub and npm run no scripts, so they get an image.

It is internal tooling — nothing in it belongs in the user-facing docs.

| file        | role                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| `record.sh` | the entry point: records each scene, renders the demo's GIF, places everything          |
| `scenes.ts` | the index: each scene's description, triggers, and what it types and presses            |
| `record.ts` | drives the example on a PTY for one scene and writes its asciicast and text snapshot    |
| `place.ts`  | puts a scene's cast in `docs/public/casts/`, points its references and fills its text   |
| `affected.ts` | lists the scenes a change may alter (their triggers), for the `/commit` skill          |
| `frames.ts` | frame-by-frame inspection of the GIF (see **Debugging**)                                 |
| `agent-chat.ts` | replays a coding agent's conversation the way Claude Code draws it, for the agent scenes |
| `conversations/` | those conversations, real Claude Code runs kept as data, and how to capture one (`README.md`) |

## Recording

```sh
./maintenance/scripts/demo/record.sh                 # every scene, from anywhere
./maintenance/scripts/demo/record.sh picker          # just the ones named
```

Needs `brew install agg ffmpeg gifsicle`, python3, and Docker for the example's infra. It drives the
**real** example workspace, so `cd example && pnpm stackctl` must boot cleanly first.

- **It needs ports 21060, 3001, 3002 and 21050 free**, and stops, naming the process, if one is held.
  It never kills anything.
- **It starts the example's infra** (`stackctl infra start`) and leaves it running.
- **It never touches the clipboard**, so you can keep working while it records.
- **It rewrites the references** to the new names: each scene's `/casts/<scene>-….cast` in
  `docs/`, its text copy, and the README's GIF, failing loudly if one stops matching, and deletes
  the previous files. The timestamp suffix is cache-busting — GitHub and npm serve the old image
  forever otherwise.

## Showing a recording in a page

```md
<llm-exclude><TerminalPlayer src="/casts/picker.cast" label="What it shows" /></llm-exclude>
<llm-only>

```text
```

</llm-only>
```

`vitepress-plugin-llms` drops `<llm-only>` from the site and `<llm-exclude>` from the LLM
files, so the site plays the recording and llms.txt reads the text. Write the block as above,
with an empty text block, add the scene to `scenes.ts` (a 74-column terminal fits a docs page)
with its `description` and its `triggers`, the files whose change can alter what it shows, and
run `record.sh <scene>`: `place.ts` fills in the cast's name and the text.

**An agent conversation** is a scene with a `program`: it runs `agent-chat.ts` in place of a
shell, replaying a real Claude Code run from `conversations/`, and hands its whole transcript in
as the text copy (`t.text`). A replay plays the same every time; `conversations/README.md` says
when and how to capture a run again.

**A screenshot** is a scene with `still: true`, shown with `<TerminalPlayer … still />`: its
cast is one frame, the screen as it stood when the scene took its snapshot, drawn as text like
any recording.

## Keeping them current

The `/commit` skill (`.claude/skills/commit/SKILL.md`) runs `affected.ts` before a commit, judges
from the diff which listed scenes really change, re-records those, and commits them with the
change. A Claude Code hook (`.claude/hooks/check-recordings.ts`) holds it to that: an agent's
`git commit` that matches a scene's triggers without a new cast for it is blocked, unless prefixed
with `STACKCTL_RECORDINGS_CHECKED=1` after judging it unchanged. Committing by hand, run
`node maintenance/scripts/demo/affected.ts` yourself.

## How the recording works

`record.ts` starts `bash` on the e2e suite's PTY driver (`packages/stackctl/e2e/pty_driver.py`) in
`example/` and plays the scene: it types the command into the prompt and presses keys at a
person's pace. The bytes are played into the e2e suite's VT screen (`e2e/screen.ts`), so each step
can wait for what is on screen, and written to the asciicast.

- **Frames are whole by construction.** Ink draws each frame as one synchronized update
  (`ESC[?2026h` … `ESC[?2026l`); `record.ts` ends each cast event outside one, so no frame shows a
  screen half drawn. The player and agg play a cast the same way every time.
- **A click aims at its word.** The demo finds `Added todo` on the screen and sends a real SGR
  double-click (one write, so both presses land inside `DOUBLE_CLICK_MS`) two cells into it,
  wherever the label width or a heartbeat has put it.
- **A copy is read from the stream.** stackctl runs with `SSH_TTY` set, so its copy goes out as
  OSC 52 into the cast instead of through `pbcopy`; the demo decodes it, fails the take unless it
  is `Added`, and pastes it into the filter. A take that fails is recorded again, up to
  `MAX_TAKES` (3).
- **The text copy is the scene's snapshot**: the rows it names, at the moment it names, with the
  screen's empty stretches as one blank line.
- **The colors are in the cast.** `THEME` in `record.ts` goes into each cast's header, and both
  the player and agg draw in it; nothing else names them.
- **The size.** Each scene names its terminal's size. The player fits the columns to its width:
  the home page's 800px container (`Layout.vue`) for the demo's 84, a docs page's column for 74.
  agg draws the GIF in 30px Menlo, an 18px cell: a 2x image, sharp on a retina screen.

## Debugging

**`node maintenance/scripts/demo/frames.ts [gif]`** (defaults to the newest `demo-*.gif`) writes
every frame to `.frames/` and reports runs where the bottom quarter has no text _inside the run phase_ (a
half-applied repaint), and frames carrying much less text than their neighbours: below **40%**
fails (a repaint artefact sits near 30%), around **50%** is a real change such as the filter
applying or the first lines arriving. Each finding prints the PNG path, so the next step is always
to open that frame. agg's frames last as long as the screen holds, so the times it prints are
only approximate; the frame numbers are exact.

**Rehearsing.** `node maintenance/scripts/demo/record.ts <scene> /tmp/x.cast /tmp/x.txt` records
one scene without placing it, and `agg /tmp/x.cast /tmp/x.gif` renders it (add `record.sh`'s flags for the
real look). Reset the remembered selection first (`pnpm stackctl --mode development reset` in
`example/`), as `record.sh` does, or the picker starts pre-selected and every keystroke lands
somewhere else.
