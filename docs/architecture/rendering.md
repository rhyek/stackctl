# Terminal UI rendering architecture

How stackctl draws its interactive terminal UI. This is a **contributor** document about
internals — not a usage guide. Read it before changing anything about the log viewport,
scrolling, the footer, the commands menu, the picker, clicks, or how output reaches the screen.
How a session ends, and the exit invariants, are in [`./exiting.md`](./exiting.md).

## The one idea to hold onto

stackctl runs as a **fullscreen TUI in the terminal's alternate screen** (like `vim`/`htop`), and
**Ink owns the entire viewport**:

- `renderApp` (`tui/App.tsx`) mounts one Ink instance with `alternateScreen: true`, so the
  original terminal contents are saved on start and restored on exit.
- The run screen is a flex column: a **log pane that fills the height** on top, and a **footer
  pinned to the bottom** by flexbox. On resize, Ink re-lays-out both — no cursor math, no gaps or
  ghosts.
- Child-process output is **rendered by Ink**, not streamed to the terminal. It lives in the
  session's `LogStore`, and a **virtualized** `LogPane` draws only the rows that fit the viewport.

The trade-off: the terminal's **native scrollback is unavailable** in the alternate screen, so
scrolling back through history is an in-app feature (mouse wheel + keys), not the terminal's own
scroll.

## The module map

```
                  ┌──────────── Session (façade) ─────────────┐
  TUI ──────────▶ │ startup order · the one shutdown path     │ ◀── control API, /events
  headless ─────▶ │ state snapshot + subscribe                │
                  └──┬───────────────┬──────────────┬─────────┘
                     │               │              │
               Supervisor        Readiness       LogStore ──▶ logfile
                     │      (waits, healthchecks)    ▲
              ServiceProcess ×N ── output lines ─────┘ (via the log formatter)
```

**The runtime, `src/session/`.** No Ink in it; the TUI, headless mode and the control API all use
it through `Session`.

- **`session.ts` — `Session`**: starts everything in order (takeover, the dev reverse proxy, the
  control server, infra, the services), runs the one shutdown path, and publishes one immutable
  `SessionSnapshot` (phase, failure, services with state/ready/exit code/waits/links/memory, infra
  entries, workspace and branch, workspace links, logfile). It implements the control server's
  `ControlManager` and the proxy's manager, watches the git branch, samples memory, and turns the
  infra step's events into `[infra]`/`[infra:<service>]` log lines and footer entries.
  `subscribe` notifies once per microtask, and the snapshot keeps its identity until something in
  it changed.
- **`supervisor.ts` — `Supervisor`**: every service process. Start, stop, restart; holding a
  service until what it waits on is ready; adding a service mid-session with its deps;
  restarting on a `.env` change; the commands menu's one-offs. Every line goes to the `LogStore`
  through the service's formatter (`logs.formatter`, else `defaultFormatter`), under its label.
  It emits typed events and polls nothing. `publicStatus` maps its states to the control API's
  `running`/`stopped`/`waiting`/`restarting`.
- **`service-process.ts` — `ServiceProcess`**: one OS process in its own process group, its
  output split into lines (title escapes stripped with `stripTitleSequences`), states that only
  move forward, SIGTERM to the group then SIGKILL after the grace. `ChildRecords` keeps the groups
  in the session record for the next session's orphan sweep.
- **`readiness.ts` — `Readiness`**: which services are ready. Probes healthchecks with a backoff
  from a fast first probe up to a cap; one loop per service however many wait on it.
- **`log-store.ts` — `LogStore`**: the line buffer, bounded by a byte budget
  (`DEFAULT_LOG_BYTES`, `lineBytes`), the filter over it, the logfile, and
  the versioned, microtask-coalesced subscription the viewport relies on. It implements
  `LogSource`, the interface `LogPane` reads.
- **`log-layout.ts`**: row counting and wrapping of one `LogLine` (timestamp + `[name]` gutter,
  hanging indent), cached per line, width and timestamp mode.
- **`headless.ts`**: the headless printer, subscribed to the `LogStore`, and `runHeadless`.
- **`start-proxy.ts`**, **`plan.ts`** (`SessionPlan` from the selection plan), **`git-branch.ts`**,
  **`types.ts`**.

Beside them in `src/`: **`selection-plan.ts`** (what a selection runs, in what order and why —
`planSelection`, `depsOf`, `dependentsOf`, `displayOrder`), **`session-takeover.ts`** (the
handshake with this mode's previous session, the orphan sweep, freeing the dev ports, ending a
session), and **`control-server.ts`** (the localhost HTTP API over `ControlManager`).

**The screens, `src/tui/`.** Each screen is a pure state reducer and a pure layout, under a thin
Ink component:

| Module                      | Role                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `App.tsx`                   | The shell: picker, then run screen, in one Ink instance; `renderApp`                                       |
| `app-exit.ts`               | What happens once Ink has unmounted: the exit line, the code, crash handling                               |
| `RunScreen.tsx`             | The run screen's composition: log pane, toasts, jump row, footer, floating menu                           |
| `use-session.ts`            | The snapshot, via `useSyncExternalStore`; no polling                                                       |
| `keymap.ts`                 | The key table: (mode, phase, focused entry, key) → `Action`; also generates every hint                     |
| `ui-state.ts`               | The reducer: mode, focus, filter, menu, armed confirmations and their expiry; returns `Effect`s             |
| `actions.ts`                | Carries out effects against the session, toasts, selection and viewport, each in a guard                   |
| `layout.ts`                 | `footerLayout` and `menuLayout`: rows of styled segments plus click targets over the same cells           |
| `text-cells.ts`             | Text measured and cut in cells; `RowBuilder`. Shared by every layout                                      |
| `Footer.tsx`, `KeysRow.tsx` | Draw the laid-out rows (`SegmentLine`, OSC 8 links)                                                       |
| `CommandsMenu.tsx`          | The floating menu, absolutely positioned above the footer                                                 |
| `FooterBoundary.tsx`        | Guards the footer's and menu's layout and drawing                                                          |
| `hit-test.ts`               | `Rect`, `Target`, last-wins hit-testing                                                                    |
| `screen-targets.ts`         | Every run-screen target in screen cells: footer, jump row, toast buttons, menu                            |
| `use-mouse.ts`              | SGR mouse reporting on/off/re-assert, report decoding, click vs drag                                      |
| `use-expiry.ts`             | One timer for the earliest armed confirmation                                                              |
| `shutdown.ts`               | The screen's part of shutdown (see `exiting.md`)                                                           |
| `picker-state.ts`           | The picker's reducer and key table                                                                        |
| `picker-layout.ts`          | The picker's rows and targets                                                                              |
| `picker-input.ts`           | The picker's view of the loaded config                                                                    |
| `Picker.tsx`                | The picker component                                                                                       |

**Modules shared with the screens**, in `src/components/` and `src/`: `LogPane.tsx`
(`useLogViewport`, `useDragSelection`, the pane), `BottomChrome.tsx`, `ToastStack.tsx`,
`footer-nav.ts` (`verticalTarget`), `log-window.ts`, `scroll.ts`, `selection.ts`,
`word-select.ts`, `mouse.ts`, `clipboard.ts`, `toasts.ts`, `wrap-rows.ts`, `timestamp-mode.ts`,
`log-formatter.ts`, `ink-output.ts`, `terminal-title.ts`.

## Screens

`App` shows the **picker** (`Picker`) unless `-s` or a usable `--last-answers` already names the
services, then the **run screen** (`RunScreen`) over a `Session` made for the picks. There is no
screen between them: startup happens inside the run screen. `renderApp` mounts with
`exitOnCtrlC: false` (each screen owns Ctrl+C), `maxFps: 120` and the kitty keyboard protocol off.

**Every screen fills the viewport.** Each screen's root is sized to the terminal
(`width="100%" height={rows}`, `rows` from `useWindowSize()`), with `overflow="hidden"`. This is
load-bearing, not cosmetic: Ink only anchors a frame at the top when it detects it as
_fullscreen_ (`outputHeight >= viewportRows`). Entering the alternate screen (`ESC[?1049h`) does
**not** home the cursor, so a short, non-fullscreen frame is drawn wherever the cursor was left on
the primary screen — near the bottom, after the shell prompt and the `▶ stackctl started` line —
leaving a large blank gap above it. Any new screen must do the same. The one deliberate exception
is the shutdown collapse (see `exiting.md`).

The width is `"100%"` rather than `columns` because of how a resize reaches the screen — see
[Resizing](#resizing).

## The run screen's layout

`RunScreen` renders a full-height flex column:

```
<Box flexDirection="column" width="100%" height={rows} overflow="hidden">
  {↑ N older lines, when content is hidden above}
  <LogPane rows={viewport.rows} />          // flexGrow: 1 — fills the height
  <BottomChrome>                            // flexShrink: 0
    <ToastStack />                          // position: absolute — adds no height
    {↓ N newer lines … Click here …, when scrolled up}
    <FooterBoundary>
      <Footer layout={footer}>              // height = footer.height
        <CommandsMenu menu={menu} />        // position: absolute, bottom: 100%
      </Footer>
    </FooterBoundary>
  </BottomChrome>
</Box>
```

- **Nothing is measured to size the pane.** The footer's height is `footerLayout(...).height`,
  known from the layout before rendering, and the two indicator rows are each 0 or 1 from the
  viewport's `hiddenAbove`/`hiddenBelow` (kept in state, so a change settles in one more render):
  `paneHeight = rows − footer.height − above − below`.
- **`BottomChrome`** (`components/BottomChrome.tsx`) is everything pinned below the log pane, as
  one bottom-aligned stack: the ↓ jump-to-latest row (only while scrolled up) above the footer,
  which it draws bare — no border, no padding.
- **`LogPane` is always rendered**, so flexbox pins the footer to the bottom from the first frame.
  The session starts in an effect after that frame, so the whole footer is up before anything
  runs.

### The footer (Design A)

Four kinds of row, no box: the rule line (workspace, branch), the services rows (the application
services, then the infra; more when they wrap), the keys row (more when it wraps) — or in filter
mode the filter row — and the links row (more when it wraps).

- **`footerLayout(snapshot, ui, cols, opts)`** (`tui/layout.ts`) is pure: no Ink, no clock. It
  returns the rows as styled `Segment`s, the `height`, the click `targets` over the exact cells
  those segments take, the entries (app services, then infra) and each entry's rect for ↑/↓.
  **Rendering and hit-testing read this one layout, so they can't disagree.** Truncation (branch,
  then workspace name, links whole, never through a URL) happens here.
- **The focused entry has the picker's caret.** A `❯` and a space go before it, the `❯` and
  the name drawn bold in `SELECTED_COLOR`, and its dot keeps its state's color. The entries
  after it on its row move over by the caret's two cells. Every services row keeps those two cells
  free, so where the rows wrap never depends on the focus. Every row starts at the first cell, and
  the workspace links end at the last.
- **The keys row is generated from the key table.** `hintsFor(keyContext)` walks `KEY_TABLE` in
  `keymap.ts`, so a hint can't advertise a key that does something else, and a hint whose action
  can't run is drawn dim. Groups are set apart by `│`, except the log's, headed by a dim `logs:`
  (`KEY_GROUP_HEADINGS`). The commands menu's own hint row comes from the same table
  (`row: 'menu'`).
- **The footer takes only the rows it draws.** It never keeps an empty row, so the keys row
  wrapping onto a second row, or the filter row or the menu's one row replacing it, moves the log
  by a row.
- `Footer`/`KeysRow` draw the rows as laid out (`SegmentLine`; a `link` segment becomes an OSC 8
  hyperlink). `Footer` and `CommandsMenu` are `memo`ized, and both layouts are `useMemo`ized on
  the snapshot, the UI state and the size, so a log line alone redraws neither.
- **`FooterBoundary`** guards the footer and the menu: a fault while laying them out or drawing
  them is logged once per guard as a `[stackctl]` error line, and the footer draws as one dim line
  instead. The log pane and the keys keep working, so Ctrl+C still quits.

### The commands menu

`menuLayout` lays the menu out as a box of rows (title, the service's scripts, `custom command…`,
its hint row) aligned with the focused entry and clamped on screen. `CommandsMenu` renders it as a
child of `Footer` with `position="absolute"` and `bottom="100%"`, so its bottom edge sits on the
footer's top edge and it **takes no layout height**: it covers the log rows under it instead of
reflowing them. Every cell inside its walls is written, so nothing under it shows through. Its
whole box is a click target, so a click inside it that misses a row or hint isn't "outside".

### Input: keys, the reducer, effects

```
useInput ─▶ resolveKey(keyContext) ─▶ Action ─┐
mouse click ─▶ target.action ────────────────┼─▶ step(uiState, event) ─▶ { state, effects } ─▶ runEffects
expiry timer ─▶ { type: 'expire' } ──────────┘
```

- `step` (`ui-state.ts`) is pure: every event carries its time, and it touches no session. It
  owns the mode (normal, filter, commands), the focus (by entry identity, so it stays put when
  entries are added), the filter text, the menu selection, and armed confirmations (`quit`, 2 s;
  `reset-infra`, 5 s), at most one per kind. A click elsewhere, or the expiry, disarms.
- `runEffects` (`actions.ts`) carries out each effect once, in its own guard: a throw or rejection
  is logged as `[ERROR] <what> failed: <message>` and the screen stays up. An action the session
  refuses (`busy`, `unavailable`, `closing`) is not an error.
- While the phase isn't `running`, no entry is focused and the arrows do nothing; while it is
  `stopping`, every key but Ctrl+C is ignored and clicks do nothing.
- Handlers read the current render's values through one `live` ref, so a burst of events in one
  read sees each update synchronously.

## The picker

The same pattern. `pickerStep(state, event)` (`picker-state.ts`) is a pure reducer over picks,
cursor, filter and scroll window, with its own key table (`PICKER_KEYS`), returning effects
(`toast`, `save-selection`, `start`, `quit`). `pickerLayout(state, input, cols, rows, runs)`
(`picker-layout.ts`) returns every row of the screen and the targets over them: the top rule, the
keys row (laid out through the same `layoutHints` as the footer), the `↑ n more` row, the list
window, the `↓ n more` row, the bottom rule and the "will start" line. `picker-input.ts` reads the loaded config
once (rows, deps, dependents, infra, the saved selection, workspace and branch), and the
"will start" line follows `planSelection` for the picks. The list height depends on how the
bottom block wraps, so the layout reports `listRows` and the component feeds it back as a
`resize` event; the layout clamps the window meanwhile. Toasts float above the bottom rule
through `BottomChrome`, as above the run screen's footer.

## Virtualized log viewport

The perf core lives in two pure, unit-tested modules and the `useLogViewport` hook
(`components/LogPane.tsx`).

- **`log-window.ts` — `computeWindow(rowCounts, paneHeight, scrollOffset)`**: variable-height
  virtualization anchored at the bottom. Given each line's rendered-row count, the pane height,
  and how far the view is scrolled up (in rendered rows from the newest output), it returns just
  the slice of lines that intersect the viewport, plus how many rows of the first/last line spill
  past the edges (`topClip`/`bottomClip`). `windowRows(...)` flattens that slice into exactly the
  on-screen rows, clipping the partially-visible ends.
- **`scroll.ts`**: the scroll position (`offset`, rows from the bottom; `0` = following the newest
  output) and its transitions — `scroll`, `scrollToTop`, `scrollToBottom`, and `onContentResized`
  (keeps a scrolled-up view pinned to the same content as the buffer grows; stays following at the
  bottom otherwise).

`useLogViewport(source: LogSource, width, height)`:

1. Subscribes to the source with `useSyncExternalStore` (snapshot = its `version`).
2. Reads the filtered visible lines, gets each line's row count (`source.countRows`, memoized per
   line and recomputed only when the width changes — and then **counted, not wrapped**; see
   [Resizing](#resizing)), runs `computeWindow`, and materializes only the visible rows with
   `source.wrapLineRows` and `windowRows` — **never more than `height` `<Text>` nodes**,
   regardless of buffer size.
3. Holds the scroll position and exposes `scrollLines` / `scrollPages` / `scrollToTop` /
   `scrollToBottom`; pins a scrolled-up view through buffer growth via `onContentResized`.

`LogPane` itself is a dumb renderer: it draws the pre-windowed rows bottom-aligned
(`justifyContent="flex-end"`, so newest sits just above the footer), each
`<Text wrap="truncate-end">` (rows are already wrapped to width).

## LogStore: a subscribable buffer

- **The subscription.** `subscribe(listener)` + `getVersion()` back `useSyncExternalStore`. The
  version moves on every change, and listeners are flushed on a **microtask**, coalescing a burst
  of appended lines into one re-render.
- **Bounded by bytes, not lines.** Each line costs `lineBytes(line)`: its text plus a fixed
  `LINE_OVERHEAD_BYTES` for the record, its slots and the layout the viewport caches for it. Over
  `DEFAULT_LOG_BYTES`, lines leave from the front in slices (a 64th of the budget at a time), so a
  full buffer doesn't move its whole array on every append. Line ids are consecutive, so a
  buffered line's index is its id minus the first one's.
- **Entries and the filter.** Continuation lines (a multi-line formatter result, an indented
  follow-on) join their head line's entry, so a filter matching any line of an entry shows the
  whole entry. `getVisibleLines()` is the buffer itself while unfiltered.
- **The logfile.** Every line is written as it arrives, stamp and label included, colors
  stripped, tabs kept. `clear` (`c`) drops the buffer and leaves the logfile.
- **Tabs.** `append` runs `expandTabs` on the buffered text, to stops of 8 columns from the start
  of its text — Ink's own expansion, done before anything measures the line. Left in, a tab
  measures as no columns, Ink widens it after the row is cut to fit, and the row loses its end.

**Formatting** happens before a line reaches the store: `Supervisor.output` runs every raw
child-process line through the service's `logs.formatter`, else `defaultFormatter`
(`log-formatter.ts`, exposed publicly as `logging.formatter()`). A formatter owns the presentation
only of the lines it **rewrites**: a line handed back unchanged — or a formatter that throws —
keeps the plain rendering, red for stderr. A multi-line result is split into separate lines of one
entry. stackctl's own status lines (`started`, `stopping…`) never pass through a formatter. The
timestamp is always stackctl's (stamped at append), never the log's own.

**Per-service `logs.timestamps`** is resolved when the session is set up and stamped onto each
`LogLine` as `showTs`, so the gutter renders and aligns each line by its own service's setting.
The logfile is always timestamped.

## log-layout: wrapping a line

`countRows(line, cols, mode, labelWidth)` and `wrapLineRows(line, cols, mode, labelWidth)`
(`session/log-layout.ts`), cached in a `WeakMap` per line, side by side per timestamp mode so
neither evicts the other, and recomputed when the width or the label width changes. The
`LogStore` passes its own `labelWidth`, so the viewport and headless never pass one:

- **One label width, owned by the `LogStore`.** A line keeps its label's bare name and color
  (`LogLabel`); `labelGutter(label, width)` pads it when it is drawn, on screen and in the logfile
  alike. The width is the longest name the store has been given with `addLabels`: each service as
  the `Supervisor` joins it (at start, or added over the control API), stackctl's own two, and
  infra's from the config and from the provider's targets. A wider name re-pads every buffered line; the logfile pads from then on.
- **Every** row carries the timestamp + `[name]` gutter, not just the first, so a wrapped line
  keeps an unbroken left gutter. The gutter is measured from the drawn label, not a nominal
  width: assuming less overflows the terminal, where `truncate-end` silently eats the tail.
- **Continuation rows** are indented by `hangingIndent(text)` — the width of a leading ` key: ` —
  so they line up under the _value_, matching how `log-formatter.ts` aligns a value containing
  newlines; falling back to the line's own leading whitespace, then to 0. The indent is capped so
  a continuation row keeps at least `MIN_WRAP_WIDTH` columns; at or below that a line stays on one
  row.
- **Wrapping** (`wrap-rows.ts`) calls `wrap-ansi` with **`trim: false`** — its default strips a
  row's leading whitespace, which eats the formatter's two-space property indent. Because
  `wrap-ansi` only wraps to one fixed width, `wrapRows` walks row by row, slicing off what the
  previous row consumed, so row 0 can be full width while the rest are narrower by the indent.

**Timestamp layout (`timestamp-mode.ts`).** A shown stamp is rendered in one of two layouts —
`time` (`HH:MM:SS`) while every timestamped line **on screen** falls on one day, `date` (the full
stamp) once two days are visible together. `useLogViewport` decides per render: it lays the buffer
out in **both** modes, tries the `time` window first and keeps it if `spansOneDay` holds over its
visible range, else renders the `date` window. The choice is a pure function of the stored scroll
position, so it can't oscillate. Because the narrower gutter reflows wrapped lines, the scroll
offset is **stored in the `date` layout's row space** (the reference layout, where no line takes
fewer rows) and translated into the rendered layout through a bottom **anchor** — the line at the
bottom edge plus its rows clipped below (`bottomAnchor` / `anchorOffset` / `convertOffset` in
`log-window.ts`). `scrollLines`/`scrollPages` move in rendered rows and translate back;
`onContentResized` measures the buffer's growth in the `date` layout so a layout flip contributes
no delta. A flip is a re-flow, so `RunScreen` clears the selection on `viewport.tsMode` as it does
on resize. The headless printer and the logfile always use the `date` stamp.

## Resizing

A resize reaches the screen in two steps, and both have to be cheap.

1. **Ink repaints on its own, immediately**, from its `resize` listener — which runs before
   `useWindowSize()` has re-rendered anything. That frame is the _previous_ React tree laid out
   again, so whatever the tree pins to the old size is drawn at the old size. This is why every
   screen's root is `width="100%"`: Ink sets its own root to the new terminal width before laying
   out, so a root that follows it puts the footer at the new width in this very frame. The log
   rows and the footer's laid-out rows in this frame are still the old ones (truncated if now too
   long), and `height={rows}` is still the old height.
2. **The React commit follows** with the new `columns`/`rows`: `footerLayout` re-lays the footer
   out at the new width — its height comes with it, so the pane is the right height in this same
   commit — `useLogViewport` re-flows the buffer, and the final frame is painted.

Step 2 is where the cost is. `useLogViewport` needs the row count of **every** buffered line —
the scroll offset, `hiddenAbove` and the selection's flat rows are all sums over the whole buffer
— and a new width invalidates every memoized count at once. So `countRows` must not wrap a line
to count its rows: wrapping (`wrap-ansi` + `slice-ansi`, re-run for every row) costs about a
thousand times what counting does, and over a full buffer it would turn one resize step into
seconds. Instead (`wrap-rows.ts`):

- `measureText(text)` runs once per line and is kept with its layout: the display width, and
  `cells` — the text with its colors stripped, when every character left is one column wide and
  its own grapheme, so that a column offset is a string index.
- A line no wider than its content width is one row: a comparison.
- A line that wraps is counted by `countWrappedRows`, which walks `cells` with `indexOf(' ')` and
  applies the same decisions `wrapRows` makes — `wrap-ansi`'s word wrap (`hard`, `trim: false`)
  and the over-long-token rule — to offsets instead of strings.
- Anything `cells` can't express (a wide glyph, a combining mark, an escape sequence that isn't a
  color) is `null` and is counted by wrapping. Such a line costs a wrap, so a buffer with many
  **wrapping** CJK or emoji lines still re-flows slowly; a short one never wraps and costs nothing.

Only the lines on screen are ever wrapped for real, by `wrapLineRows`. The two share one decision
of whether a line wraps and by what hanging indent.

## Mouse and scrolling

**`use-mouse.ts`** (`useMouse(active, io, handlers)`) is shared by the run screen and the picker.
It enables SGR mouse reporting by writing `MOUSE_ENABLE` (`ESC[?1002h` button-event tracking +
`ESC[?1006h` SGR coordinates, from `mouse.ts`) while active, and `MOUSE_DISABLE` on cleanup. Ink
never hands a mouse report to `useInput` — it drops terminal sequences that map to no key — so the
hook reads them from the raw chunks Ink emits as `data` while it reads stdin, before it parses
them into input events. A chunk can mix reports with keys and a report can be split across two
reads, so `createMouseDecoder` keeps a report's unfinished start for the next chunk.

`MOUSE_ENABLE` is **re-asserted on every resize**, because a terminal can hand the session to a
_fresh_ emulator that restores the modes from an incomplete snapshot. VS Code's "Reload Window"
does exactly this: the pty is reattached to a new xterm.js restored by its `SerializeAddon`,
which re-emits the _tracking_ mode (`?1002h`) but not the _encoding_ mode (`?1006h`). Reports then
resume in the legacy X10 encoding (`ESC[M` + three coordinate bytes), which the SGR decoder
doesn't match — so the wheel, clicks and drag-select go silently dead while the keyboard keeps
working. A reattach always re-measures the terminal, so the resize heals it before the next mouse
event. As a backstop, the decoder recognizes an X10 header in a chunk and the hook re-asserts on
the spot. Ink drops the header, but its coordinate bytes reach `useInput` as one input event of
their own; `mouse.dropKey()` swallows it, so they can't type themselves into the filter or a
custom command. X10 itself is never decoded — it caps at column 223 and its raw bytes are mangled
by UTF-8 decoding, and re-asserting brings SGR straight back.

Each report is dispatched one of three ways:

- **Wheel** (buttons 64/65): `onWheel`. The run screen scrolls the viewport `WHEEL_ROWS` rows; the
  picker moves its cursor.
- **A click**: a press and a release on the **same target** (by `id`, stable across layouts) with
  no drag between them. `onClick(target)` — the target's `action` goes through the reducer as a
  `click` event; a toast button's `press` runs directly (still disarming through the reducer). A
  press and release on nothing is a click on no target, which disarms confirmations.
- **A press on no target, its drag and release**: `onPointer` — the log's drag selection. The
  picker has none.

**Click targets** (`hit-test.ts`) are `{ id, rect, action | press }` in 1-based screen cells, the
coordinates SGR reports use, and `hitTest` is **last-wins**, so the list is built drawn-last last.
`screenTargets` (`screen-targets.ts`) assembles the run screen's: the footer's, then the jump row's
`Click here` and the toast buttons (one cell of slack each side), then the menu's. The footer's and
the menu's come from the pure layouts, with rows relative to the footer (0 = the rule line, the
menu's negative) offset to screen rows. Only the jump row and toast buttons need their elements'
positions, which `elementRect` recovers by summing each ancestor's yoga `getComputedLeft/Top` up
the `parentNode` chain (`measureElement` returns only width/height).

- **Every hint is a target** that dispatches exactly its key's action, confirmations included.
- **Services-row entries** focus that entry (`focus-index`).
- **Links** on the links row are OSC 8 hyperlinks and no target: the terminal's own gesture
  (Cmd+click) opens one, and stackctl never launches a browser.
- **`Click here`** in the ↓ row scrolls to the bottom, the mouse equivalent of `End`.
- **A toast's `[action]`**; the armed reset's `[reset]` confirms through the reducer, naming its
  entry, so it expires like the key's confirmation.
- In filter mode the copy icon, links and the jump row still act; every other click only disarms.
  While the menu is open, a click outside it closes it and is consumed.

**Keyboard scrolling** (normal mode): `PgUp`/`PgDn` page, `Home`/`End` jump to oldest/newest (End
re-enters follow). The arrows move the footer focus, which runs over the app services and then the
infra entries: `←`/`→` step through that one list with wrap-around, `↑`/`↓` go to the nearest
entry on the row above or below, through `verticalTarget` (`footer-nav.ts`) over the layout's
entry rects. Any keyboard scroll drops an active selection. In the menu, `↑`/`↓` move within the
focused service's commands and `←`/`→` switch the focused service in place.

**Scroll indicators** frame the pane when the log overflows: `↑ N older lines — press Home to jump
to oldest` at the very top whenever content is hidden above, and `↓ N newer lines — press End or
Click here to jump to latest` above the footer whenever content is hidden below. Each is
**centered** in the viewport. The bottom one's `Click here` is split into its own `<Box>`/`<Text>`
purely to carry the ref, with the surrounding spacing kept inside the neighbouring strings rather
than as a `columnGap`. The centering `justifyContent` wraps a **single** child which then holds
those three pieces: an odd amount of free space centers on a half column, and justifying the
pieces directly makes each round it independently — which drifts them apart, doubling a space and
clipping the last character.

## Text selection (drag, double-click, triple-click)

Because Ink owns the screen and repaints cells in place, the terminal's **native** click-drag
selection can't survive a scroll or an incoming log line (it's anchored to screen cells, which
stackctl overwrites). So selection is **app-managed**, tmux-style: enabling mouse reporting takes
the mouse from the terminal, and `useDragSelection` (`components/LogPane.tsx`) reimplements
select-and-copy over the log content.

- **Content-anchored coordinates.** A selection is two points in the viewport's **flat
  rendered-row space** (`selection.ts`): row 0 is the oldest rendered row of the whole buffer, and
  a row keeps its index as new output is appended below it. `useLogViewport` exposes
  `firstVisibleFlatRow` to map between screen rows and that space. Anchoring here — not to screen
  cells — is what lets a selection ride along as content scrolls and as logs arrive. It's only
  invalidated by a re-flow: resize, a timestamp-layout flip, filter change, or `c` clear (all
  clear it); eviction at the byte budget shifts flat rows, the one accepted edge case.
- **Value-scoped copy.** A rendered row's gutter (timestamp + `[name]`) and hanging indent are
  presentation, not text, so a copy that began _inside a value_ drops them. `classifyLine` locates
  where a line's value starts (` key:` → after the key; `[LEVEL] ` → after the token;
  indented-with-no-key → after the indent; anything else → column 0). `down` compares the press
  column against that: at or past it selects in `mode: 'value'` and records the `valueRun` (the
  line's wrapped rows plus any following indented continuations); left of it — the gutter or the
  key — keeps WYSIWYG mode, the escape hatch for copying a line as shown. `selectionCopyText` then
  floors every row at its `valueStart` and rejoins: rows of the **same** line with no separator
  (the terminal introduced that break), distinct lines with a newline. Dragging either end outside
  the run reverts the whole copy to WYSIWYG. `rowSpan` takes the same floor so the highlight shows
  exactly what will be copied. `classifyLine` is deliberately **not** `hangingIndent`
  (`session/log-layout.ts`): that returns 0 for a `[LEVEL] …` header so a wrapped message stays
  flush with the gutter, while this returns the token width so selecting a message starts after
  `[INFO] `. Keep them separate.
- **Drag → select → copy-on-release.** `down` starts the selection; `move` (button held) extends
  it; `up` finalizes it, captures the ANSI-stripped text and **copies it immediately** —
  `copyToClipboard` + a `✓ copied N chars to clipboard` toast, with no key press. In the VS Code
  integrated terminal Cmd+C is swallowed by VS Code's keybinding layer before it reaches the
  process (its default Cmd+C binding needs a _native_ xterm selection, which mouse reporting
  suppresses), so a copy hotkey can't be made reliable there; copying on release sidesteps the key
  entirely. The highlight then **lingers for `SELECTION_LINGER_MS`** (the toast's duration), so
  the two go away together; they are two timers, though, and dismissing the toast alone leaves
  the highlight up. `esc` (or a filter change / resize / `c` / a fresh drag) clears both sooner.
  Scrolling does **not** clear it. The live selection lives in a ref (not state) so a burst of
  `move`+`up` in one read see each other synchronously; a reducer bump forces the repaint.
- **`flashCopy(text, label)`** is the shared copy-and-toast: a link click uses it with `copied
  link`.
- **Clipboard (`clipboard.ts`), prompt-aware.** Locally it uses the **native command**
  (`pbcopy`/`clip`/`wl-copy`/…) only — reliable, and unlike OSC 52 it never trips a terminal's
  clipboard-access prompt. **OSC 52** is used over SSH (the only thing that reaches the user's
  local terminal) and as a local fallback when no native binary exists.
- **Highlight rendering.** `LogPane` gets a per-visible-row span; a highlighted row is split with
  `slice-ansi` into colored `pre`/`post` and an ANSI-stripped `mid` rendered `<Text inverse>`
  (stripping the middle sidesteps the embedded `ESC[0m` resets in log text cancelling the
  inversion).
- **Filter matches** (`match-highlight.ts`, pure) are painted first, so a selection inverts over
  them. `LogPane` takes the applied filter's terms (`filterTerms`, the split `LogStore` matches
  with) and searches each row's `[label]` (its columns, `label`, come from `wrapLineRows`) between
  the brackets, then each logical line's content from `contentStart` (rows sharing a
  `lineIndex` as one text, so a match the wrap broke still shows on both rows), never the
  timestamp, with each grapheme folded by `normalize` and mapped back to its display columns. A
  match is stripped of its own colors and drawn `ON_MATCH_COLOR` on `MATCH_COLOR`, so gold or
  pastel text stays readable. Painting happens at render time, never in `RowMeta.text`, which
  selection and copy read and the row cache doesn't key on the filter.
- **Double-click a word, triple-click a line** (`word-select.ts`, pure). Both select **and copy
  immediately**, reusing `flashCopy`.
  - **Detecting the multi-click is on us.** The SGR protocol carries **no click count**, so
    `trackClick` times it: a second press within `DOUBLE_CLICK_MS` (300 ms, tmux's
    `KEYC_CLICK_TIMEOUT`) on the **same cell**, tracked in _content_ coordinates (`col` +
    `flatRow`), so a wheel scroll between two presses breaks the streak for free. `mouse.ts` stays
    a pure protocol parser.
  - **A URI short-circuits everything.** `wordSpanAt` first matches `scheme://…` up to whitespace
    and, if the press landed inside one, returns that whole match (minus trailing sentence
    punctuation and closing pairs). This runs _before_ the character rules because inside a URI
    `?`, `=` and `&` bind rather than separate.
  - **Word boundaries** otherwise follow the model every emulator uses — word characters
    `[\p{L}\p{M}\p{N}_]` plus _joiners_ `- . / ~ : @ # % +` — with trailing joiners (minus `/`)
    trimmed from the **end** only, so `./scripts/x.sh.` comes out as `./scripts/x.sh` while
    `.env`, `~/src` and `--verbose` keep their lead. `=`, `?` and `&` are deliberately _not_
    joiners.
  - **Wrapping is invisible to it.** `wordSelectionAt` gathers every rendered row sharing the
    clicked row's `lineIndex`, concatenates each one's content past `contentStart`, and runs the
    rules over _that_ — lossless, because `wrapRows` inserts nothing — so a URI split by the
    terminal's width still copies unbroken.
  - **Triple-click** inside the value takes the whole `valueRun` in value mode; on the gutter it
    takes the rendered row as shown.
- **Escape hatch.** With reporting on, the terminal's own selection is disabled; most terminals
  still force native selection while **Option/Alt** is held.

## Toasts

Transient notices, floating over the bottom of the log pane (or above the picker's bottom rule).
`toasts.ts` is the pure policy (what a toast is, the `MAX_TOASTS` cap, which one gives way);
`components/ToastStack.tsx` holds the React plumbing (`useToasts` — ids, expiry timers, click
targets) and the renderer.

- **`notify({ message, tone?, duration?, actions? })`** returns an id; `dismiss(id)` takes it down
  early. `duration` is ms or `'sticky'` — sticky toasts wait for the user, cleared by clicking an
  action or by `esc`.
- **Who raises one:** a copy (`flashCopy`), a filter change (`Filter applied` / `Filter
  cleared`, only when the filter actually changed), the quit confirmation (`Press Ctrl+C again to
  exit`, for its 2 s) and the reset confirmation (with its `[reset]` button, for its 5 s), both
  from `actions.ts`, which takes a confirmation's toast down when it disarms; the picker's
  locked-dependency notice, which replaces the previous one rather than stacking.
- **`esc` order** is selection → newest **sticky** toast → filter, so a sticky toast is always
  dismissible without a mouse. Transient toasts are deliberately _not_ in that chain: they clear
  themselves, so letting one absorb the `esc` aimed at the filter beneath it would only cost a
  keypress.
- **The stack takes no space, and that is layout — not measurement.** It is a `position: absolute`
  child of `BottomChrome` with `bottom: 100%` and `right: 0`, so it is out of flow (the pane keeps
  every row, nothing reflows when a toast appears) and its bottom edge is glued to `BottomChrome`'s
  top edge. When the jump-to-latest row appears the chrome grows and the stack rides up with it.
  **Never reintroduce a measured height for this** — Yoga resolves it, and Ink parses a string
  offset as a percentage (`setPositionPercent`), which is what makes `bottom="100%"` work at all.
  The commands menu floats the same way.
- **It paints over the tail of the last log rows.** With no `backgroundColor` only the glyphs are
  written, so the rest of each row shows through, and `right: 0` with an auto width keeps the
  overlay where log lines have usually run out. A drag underneath still selects the text it covers
  (selection is content-anchored).
- **The cap is a hard bound.** Over `MAX_TOASTS` (3) the oldest **transient** toast gives way
  first — a burst of routine notices must not silently retire a sticky one waiting on the user.
- **`useDragSelection` takes `notify`/`dismiss`, never the whole `Toasts` object.** That object is
  rebuilt every render; closing over it would change `clear`'s identity, and `clear` is a
  dependency of `RunScreen`'s re-flow effect — which would then fire on every render and drop the
  selection the instant it was made. Both callbacks are `useCallback`-stable for exactly this
  reason.
- **Timers close over the id alone**, never over the toast list, so they can't go stale.

## Memory: what a frame costs

A frame's cost is set by the screen's size, not by what changed: Ink lays every text node onto a
grid of cells the size of the screen and turns each row of it back into a string, on every frame.
How much memory a session holds follows from how much that allocates, because V8 sizes its young
generation by the allocation rate and keeps what it grew to. Four things keep it small.

- **A lean compositor** (`ink-output.ts`). Ink's own `Output` builds the grid from fresh cell
  objects and diffs the styles of every pair of neighboring cells, several `Set`s and arrays per
  cell even when both are blank. `renderAppInProduction` installs a port of Ink's
  `applyWriteOperation`, `sliceLineToColumns` and `get` over `Output.prototype` before the first
  frame. It shares one blank cell across the grid, skips the diff between neighbors whose styles
  are the same, and keeps tokenized lines across frames in a bounded LRU. It installs only over the
  Ink it was ported from (`INK_VERSION`, which `package.json` pins exactly) and leaves Ink's own in
  place otherwise.
- **A capped young generation** (`relaunch.ts`). A session starts itself over with
  `--max-semi-space-size=2` through `process.execve` (same pid and terminal), since V8 reads the
  flag only at startup. One-off commands don't: the extra startup is a good part of their run.
- **React's production build** (`render-app-production.ts`): the development build emits a
  `performance.measure()` per render that Node never flushes.
- **No frame without a change.** The one animation is the blinking dot of a service on its way,
  and its clock runs only while such a dot is on screen (`hasBlinkingDot`, `layout.ts`); with
  none, no timer redraws. The memory sampler notifies only when a shown figure changes,
  the snapshot keeps its identity otherwise, and a log line re-renders the pane, not the footer.

## Headless

`--headless` (and `startStack()`'s forked session) draws no frames. `createHeadlessPrinter`
subscribes to the `LogStore` and prints each line once, in order, as `wrapLineRows` lays it out in
`date` mode at stdout's width (`PIPED_COLUMNS` when piped), one write per line, error lines on
stderr; with `echo` off (a forked session) only `[stackctl]` lines. Infra's progress lines come
from `infra/report.ts`'s reporter, written through the printer so they interleave in order with the
log; infra's output lines come from the store. It shares the session, the store and the layout
with the TUI, and none of the Ink rendering.

## Roads not taken (and why this shape)

- **Write-above on the primary screen**: Ink renders only the footer, logs go to real **native
  scrollback**, and the footer is hand-anchored to the bottom via cursor math. Keeps the
  terminal's own wheel scroll, but the hand-anchoring is fragile (resize gaps/ghosts) and can't
  pin a footer without a 1-row cursor line. Ink owning the screen makes the footer and resize
  trivially correct and enables the virtualized viewport — at the cost of reimplementing scroll
  in-app.
- **Alternate-scroll mode** (`?1007h`) for the wheel: translates the wheel into arrow keys without
  capturing the mouse, so the terminal's **native** selection keeps working. But native selection
  can't survive in-place repaints (it goes static on new logs and copies the wrong line), so full
  SGR mouse **reporting** (`?1002h`+`?1006h`) drives an app-managed selection instead. The cost:
  the terminal's own selection is off while stackctl runs (Option/Alt still forces it).
- **An explicit copy-mode** (freeze the frame, move a cursor, `y` to yank, like tmux copy-mode):
  more robust but modal and higher-friction. Rejected for seamless always-on drag-select.
- **A copy hotkey instead of copy-on-release:** the reflexive gesture — drag, then Cmd+C — can't
  work in the VS Code integrated terminal (Cmd+C never reaches the process), and per-user
  `keybindings.json` isn't shippable for a published package. The accepted cost of copying on
  release is that any drag overwrites the clipboard.
- **Hit targets from measured elements:** measuring every clickable element after each render
  lags a frame behind the layout and can't be tested without Ink. Laying the footer, menu and
  picker out as pure data gives rendering and hit-testing one source, testable cell for cell.

## Invariants to preserve

- The interactive screens never write to the terminal directly, mouse modes and the exit paths
  aside — the screen is a pure function of the snapshot, the store and the UI state, rendered by
  Ink.
- `LogPane` renders at most `paneHeight` rows; keep the windowing (`computeWindow`/`windowRows`) as
  the single source of what's on screen.
- `countRows(line, cols, mode)` equals `wrapLineRows(line, cols, mode).length`, always. The count
  is worked out separately from the wrap (see [Resizing](#resizing)), so nothing but the specs
  holds the two together — and a count that is off by one shifts every row below it, in the
  window, the scroll offset and the selection alike. `countWrappedRows` reproduces `wrap-ansi`'s
  rules as of the pinned major; `wrap-rows.spec.ts` and the row-count cases in
  `session/log-layout.spec.ts` catch an upgrade that changes them.
- **One layout per screen feeds both drawing and hit-testing.** A click target's rect is computed
  with the cells it covers, in `layout.ts` / `picker-layout.ts`; never position a target from a
  separate calculation. Only elements the pure layouts don't place (the jump row, toast buttons)
  are found through the element tree.
- **Every hint comes from a key table**, so a hint and its key can't disagree, and a click on a
  hint dispatches exactly the key's action.
- **The footer holds no empty row.** Its height is the rows it draws; the menu and toasts float
  out of flow.
- **The reducers are pure** (`step`, `pickerStep`): no clock, no session, no Ink. Effects run once,
  from `actions.ts` or the picker component, each in a guard.
- The headless path stays a line printer over the store, with none of the Ink rendering.
- The lean compositor draws every frame byte for byte as Ink's own does; `ink-output.spec.ts`
  compares the two on thousands of random frames. Ink stays pinned to an exact version, and
  upgrading it means porting the compositor again from the new `ink/build/output.js`.
- Nothing redraws on a timer while the screen has nothing to show changing.
- SGR mouse **reporting** is enabled while the picker or the run screen is mounted and **must be
  disabled on every exit path** (`exiting.md`). Enabling is **not** once-on-mount: keep the
  re-assert on resize and the legacy-report backstop, or a terminal reattach leaves the mouse dead
  until restart.
- The toast stack and the commands menu float **out of flow** (`position: absolute`,
  `bottom: 100%`). Keep it that way: put either in the column and it steals log rows and reflows
  the pane. Their anchoring is pure layout — never computed from a measured height.
- Text selection is app-managed and **anchored to flat-row/column content coordinates**, never to
  screen cells. Clear it on any re-flow (resize, timestamp-layout flip, filter, `c`); don't clear
  it on plain appends.
- The tab/window title is pinned once to `stackctl: <cwd basename>` on mount (`renderApp`, via
  `terminal-title.ts`). Child processes emit their own OSC 0/1/2 title escapes, which would make
  the tab flicker, so `stripTitleSequences` removes them where output is captured
  (`ServiceProcess`, `InfraControl`). Keep both halves: set our title, and strip theirs.
- On shutdown, collapse the UI to a short (non-fullscreen) frame so Ink's fullscreen-unmount clear
  can't leave a blank block on the restored screen.

## File / symbol map

| Concern                                                   | Where                                   |
| --------------------------------------------------------- | --------------------------------------- |
| Alternate screen, picker → run screen, `renderApp`        | `tui/App.tsx`                           |
| Run-screen composition, input and mouse wiring            | `tui/RunScreen.tsx`                     |
| Footer and menu layout (rows + targets)                   | `tui/layout.ts`                         |
| Key table, hints                                          | `tui/keymap.ts`                         |
| UI state reducer, confirmations                           | `tui/ui-state.ts`                       |
| Effects against the session                               | `tui/actions.ts`                        |
| Picker reducer, layout, config view, component            | `tui/picker-state.ts`, `picker-layout.ts`, `picker-input.ts`, `Picker.tsx` |
| Click targets, hit-testing                                | `tui/hit-test.ts`, `tui/screen-targets.ts` |
| SGR mouse hook                                            | `tui/use-mouse.ts`                      |
| SGR mouse escapes + stdin-chunk decoder                   | `mouse.ts`                              |
| Snapshot subscription                                     | `tui/use-session.ts`                    |
| Viewport hook, drag-select hook, presentational pane      | `components/LogPane.tsx`                |
| Virtualization math (`computeWindow`/`windowRows`)        | `log-window.ts`                         |
| Row counting and wrapping of a log line                   | `session/log-layout.ts`, `wrap-rows.ts` |
| Buffer, filter, logfile, subscription                     | `session/log-store.ts`                  |
| Output formatting into the store                          | `session/supervisor.ts`, `log-formatter.ts` |
| Scroll position + transitions                             | `scroll.ts`                             |
| Selection geometry/text math (highlight, copy text)       | `selection.ts`, `word-select.ts`        |
| Toast policy (shape, cap, eviction)                       | `toasts.ts`                             |
| Toast hook, timers, click targets, overlay renderer       | `components/ToastStack.tsx`             |
| Bottom-aligned stack: jump row, footer, toast anchor      | `components/BottomChrome.tsx`           |
| ↑/↓ between wrapped rows                                  | `components/footer-nav.ts`              |
| Best-effort clipboard (OSC 52 + native command)           | `clipboard.ts`                          |
| Tab/window title + stripping child title escapes          | `terminal-title.ts`                     |
| Headless printer                                          | `session/headless.ts`                   |
| Ink's frame compositor, ported and installed              | `ink-output.ts`                         |
| React's production build for Ink                          | `render-app-production.ts`              |
| Restarting with a capped young generation                 | `relaunch.ts`                           |
