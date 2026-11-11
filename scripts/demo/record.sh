#!/usr/bin/env bash
# Record the stackctl demo GIF end-to-end. Renders the VHS tape at 2x (crisp, supersampled
# text), then downscales ~1.5x — which thins out macOS's heavy font stem-darkening — and crops
# to a uniform ~20px margin, producing the committed GIF at docs/public/demo-<unix-ts>.gif,
# which the site serves and the README links to — the timestamp suffix busts GitHub's and
# npm's image caches, so a re-recording is actually visible. Any previous demo GIF is deleted
# and the README's image URL and the home page's `demo.src` are rewritten to the new filename.
# Run it from anywhere (e.g. `./scripts/demo/record.sh`).
#
# A take is kept only if it passes two checks, and the script records up to MAX_TAKES (3) of
# them until one does: the double-click really copied `Added`, and `frames.ts` finds no frame
# the recorder caught mid-repaint (half the screen drawn, the rest blank). A take that fails
# either is dropped, and if none passes the previous GIF stays as it is. Each take waits until
# the machine's load is at most MAX_LOAD (twice the cores): a busy machine is what makes
# headless Chromium fall behind the repaints.
#
# Requires: brew install vhs ttyd ffmpeg (plus expect, which macOS ships), and Docker for the
# example's infra. The recording drives the real example (Go worker + Vite frontend), so a
# plain `pnpm stackctl` must boot cleanly here first, with its ports (3000-3002, 21050) free.
# It uses the clipboard: the recording double-clicks a word in the log, which really copies
# it, and then pastes it back into stackctl's filter. The clipboard's text is put back at the
# end; anything else on it (an image, a file) is lost.
set -euo pipefail
cd "$(dirname "$0")"

RAW="demo.raw.gif"
TAKE="demo.take.gif"
MAX_TAKES="${MAX_TAKES:-3}"
MAX_LOAD="${MAX_LOAD:-$(( $(sysctl -n hw.ncpu) * 2 ))}"
PUBLIC="../../docs/public"
README="../../README.md"
HOME_PAGE="../../docs/index.md"
OUT_NAME="demo-$(date +%s).gif"
OUT="$PUBLIC/$OUT_NAME"

# The example's dev ports and its proxy's have to be free, or it won't boot cleanly. A port
# that is held is someone's running process: say whose, and stop there rather than kill it.
for port in 3000 3001 3002 21050; do
  holder=$( (lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) | tail -n +2 | awk '{ print $1 " (pid " $2 ")" }' | sort -u | paste -sd, -)
  if [ -n "$holder" ]; then
    echo "error: port $port is in use by $holder; stop it and run this again" >&2
    exit 1
  fi
done

# The example's infra (Postgres, the mail catcher), up and migrated before the tape starts, so
# the recorded startup takes the second it takes on a warm machine.
(cd ../../example && pnpm stackctl infra up)

# 1) The recording uses the system clipboard, so keep its text and put it back afterwards.
CLIPBOARD=$(mktemp)
pbpaste > "$CLIPBOARD"
trap 'pbcopy < "$CLIPBOARD"; rm -f "$CLIPBOARD" "$RAW" "$TAKE"' EXIT

# The 1-minute load average, as a whole number.
load() {
  sysctl -n vm.loadavg | awk '{ printf "%d", $2 }'
}

kept=""
for take in $(seq 1 "$MAX_TAKES"); do
  # Wait (up to five minutes) for the machine to settle.
  for _ in $(seq 1 30); do
    [ "$(load)" -le "$MAX_LOAD" ] && break
    echo "take $take: load $(load) is above $MAX_LOAD, waiting..." >&2
    sleep 10
  done

  # 2) Seed the clipboard with what the double-click is expected to copy, in the wrong case:
  #    the tape pastes the clipboard into stackctl's filter, so if the injected click ever
  #    misses, the GIF shows this instead of whatever the machine had on the clipboard, and the
  #    check below tells the two apart.
  printf 'added' | pbcopy

  # 3) Render the tape -> $RAW at 2x (see `Output` + the `Set` block in demo.tape).
  vhs demo.tape

  copied=$(pbpaste)
  if [ "$copied" != "Added" ]; then
    echo "take $take: the double-click copied '$copied', not 'Added'; dropped" >&2
    continue
  fi

  # 4) Thin the strokes, then downscale ~1.5x and crop to a uniform ~20px margin.
  #    - Chrome draws the terminal with macOS font smoothing, which thickens every stroke; a
  #      terminal like kitty draws Menlo without it. `erosion` takes the anti-aliased edge of
  #      each stroke down by at most 48 per channel at 2x, which brings the weight back to that,
  #      while a stroke's solid middle (its color) is untouched and bold still reads bold.
  #    - The downscale leaves the final ~1680px wide, so npm/GitHub never upscale it and it
  #      stays crisp on retina. The crop numbers match demo.tape's Set block (Width 2600 /
  #      Height 1600 / Padding 62): re-derive them if you change the terminal size or padding.
  #    - A full-palette + fine ordered dither keeps colors clean.
  ffmpeg -y -i "$RAW" \
    -vf "erosion=threshold0=48:threshold1=48:threshold2=48,scale=iw*2/3:ih*2/3:flags=lanczos,crop=1678:993:27:31,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
    "$TAKE"

  if node frames.ts "$TAKE"; then
    kept="$take"
    break
  fi
  echo "take $take: frames.ts found a frame that looks off; dropped" >&2
done

if [ -z "$kept" ]; then
  echo "error: none of $MAX_TAKES takes passed; the previous GIF is unchanged" >&2
  exit 1
fi
mv "$TAKE" "$OUT"
echo "take $kept passed: the click copied 'Added' and no frame looks off"

# 5) Point the README's image URL, and the site's home page, at the new filename, and bail if
#    either didn't take — this runs before the old GIF is dropped, so a file the pattern no
#    longer matches aborts the script with the previous recording still in place rather than
#    with a link to a deleted file.
sed -i '' -E "s|public/demo(-[0-9]+)?\.gif|public/$OUT_NAME|g" "$README"
grep -q "public/$OUT_NAME" "$README" || {
  echo "error: could not find the demo GIF URL to update in README.md" >&2
  exit 1
}
sed -i '' -E "s|src: /demo(-[0-9]+)?\.gif|src: /$OUT_NAME|" "$HOME_PAGE"
grep -q "src: /$OUT_NAME" "$HOME_PAGE" || {
  echo "error: could not find the demo GIF to update in docs/index.md" >&2
  exit 1
}

# 6) Drop any earlier demo GIF, so the site ships one recording.
find "$PUBLIC" -maxdepth 1 -name 'demo*.gif' ! -name "$OUT_NAME" -delete

echo "wrote $OUT ($(du -h "$OUT" | cut -f1)); README.md and docs/index.md updated"
