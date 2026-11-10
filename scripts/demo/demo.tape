# stackctl demo — the tape behind the README hero GIF (records the example monorepo's TUI).
#
# Don't run this tape directly. Use the wrapper (from the repo root), which renders it and
# then does the 2x->1x downscale (thins macOS font stem-darkening) + uniform-margin crop that
# produce the committed GIF:
#   ./scripts/demo/record.sh
#
# record.sh documents what has to be installed and what the recording touches; this file is
# just the choreography. See CLAUDE.md for how the demo's double-click works.

Output demo.raw.gif

Require pnpm
Require expect

Set Shell "bash"
Set FontFamily "Menlo"
# Rendered large, then downscaled ~1.5x on export (see record.sh): the supersampling thins
# macOS's heavy font stem-darkening (VHS has no thin-strokes/font-weight setting), while the
# ~1680px final width means npm/GitHub never upscale it and it stays crisp on retina. FontSize
# is tuned to keep ~120 columns at this width.
Set FontSize 36
Set Width 2600
Set Height 1600
Set Padding 62
# Cap the capture rate to what headless Chromium can sustain at this render size, so VHS
# doesn't drop frames and time-compress the result — this keeps playback at real speed.
Set Framerate 15
Set TypingSpeed 55ms
# Vibrant palette sampled from the original terminal screenshot (bg #24292E) so the ANSI
# status colors read as punchy as a real terminal rather than washed-out pastel.
Set Theme { "name": "stackctl", "background": "#24292E", "foreground": "#CFD3D7", "black": "#3B4048", "brightBlack": "#6D6D98", "red": "#DF6974", "brightRed": "#F97583", "green": "#36CB61", "brightGreen": "#56D364", "yellow": "#E5C07B", "brightYellow": "#FFC777", "blue": "#4E9CCD", "brightBlue": "#79C0FF", "magenta": "#9B72E3", "brightMagenta": "#C8A2FF", "cyan": "#4EC9D3", "brightCyan": "#56D4DD", "white": "#CFD3D7", "brightWhite": "#FFFFFF", "cursor": "#CFD3D7", "selection": "#3A6A9E" }

# --- hidden setup: clean prompt + fresh selection so the picker starts empty ---
Hide
# Run everything under click.exp — a transparent expect wrapper that forwards this shell
# both ways and, mid-recording, writes one real SGR mouse report into stackctl's stdin.
# That's the demo's double-click-to-copy: VHS has no mouse command, so the click has to
# come from inside the pty. See click.exp.
Type "exec expect -f click.exp" Enter
Sleep 500ms
Type "export PS1='$ '" Enter
Sleep 300ms
# Force the footer's git branch to read `main` no matter which branch we record from.
Type "export STACKCTL_DEMO_RECORDING=1" Enter
Sleep 200ms
Type "cd ../../example" Enter
Sleep 300ms
Type "pnpm stackctl --mode development reset" Enter
Sleep 1500ms
Type "clear" Enter
Sleep 500ms
Show

# --- launch: the service picker ---
Type "pnpm stackctl" Enter
Sleep 2500ms

# select each service one by one (space toggles the row under the cursor)
Space
Sleep 500ms
Down
Sleep 350ms
Space
Sleep 500ms
Down
Sleep 350ms
Space
Sleep 900ms
Enter

# --- run screen: backend + frontend + worker boot together, the infra already up ---
# Start moving the focus while logs are still settling, so the demo never looks frozen.
Sleep 4500ms

# quick tour of the footer (fast — just showing the focus move): across the services and on to
# the first infra service, whose keys replace the service ones, then back to the backend
Right
Sleep 400ms
Right
Sleep 400ms
Right
Sleep 900ms
Left
Sleep 400ms
Left
Sleep 400ms
Left
Sleep 800ms

# open the backend's commands menu, arrow across to the frontend's scripts without leaving the
# menu, and back
Type "m"
Sleep 1500ms
Right
Sleep 1500ms
Left
Sleep 1200ms

# run the backend's add-random-todo. Once it finishes, click.exp waits a beat and then
# double-clicks the word `Added` — the highlight and the `✓ copied 5 chars to clipboard`
# notice are stackctl's double-click-to-copy. This sleep has to cover the command, that beat,
# and long enough after the click to read the notice.
Enter
Sleep 5000ms

# filter the combined log down to the added todos (case- and accent-insensitive) — by
# pasting the word we just copied, since it's genuinely on the system clipboard now.
Type "f"
Sleep 1000ms
Paste
Sleep 800ms
Enter
Sleep 2500ms

# clear the filter (esc), then quit: once services run, Ctrl+C asks for a second press
Escape
Sleep 2000ms
Ctrl+C
Sleep 900ms
Ctrl+C
Sleep 2500ms
