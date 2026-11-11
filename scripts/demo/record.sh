#!/usr/bin/env bash
# Record the docs' terminal recordings end-to-end. For each scene in scenes.ts (or the ones named:
# `./scripts/demo/record.sh picker`), record.ts drives the example's real shell and stackctl on a
# pseudo-terminal and writes an asciicast and a text snapshot, and place.ts puts them where the
# docs show them: docs/public/casts/<scene>-<unix-ts>.cast, played as text on the site
# (asciinema-player), and the text copy beside each player that llms.txt reads instead.
#
# The demo scene also becomes docs/public/demo-<unix-ts>.gif, agg's render of its cast, for the
# README: GitHub and npm run no scripts. The timestamp suffixes bust GitHub's, npm's and browsers'
# caches, so a re-recording is actually seen. Run it from anywhere.
#
# A take comes out whole every time: its frames are cut where stackctl's frames end, so none
# shows a screen half drawn, and a cast plays and renders the same way on every run. What a take
# can still get wrong is the demo's double-click (a heartbeat landing between finding the word and
# clicking it), which the scene checks; each scene is recorded up to MAX_TAKES (3) times until it
# passes. `frames.ts` checks the GIF too, as a guard.
#
# Requires: brew install agg ffmpeg, python3 (for the e2e suite's PTY driver), and Docker for the
# example's infra. The recording drives the real example (Go worker + Vite frontend), so a plain
# `pnpm stackctl` must boot cleanly here first, with its ports (3000-3002, 21050) free. It never
# touches the clipboard (see record.ts).
set -euo pipefail
cd "$(dirname "$0")"

SCENES=("$@")
if [ ${#SCENES[@]} -eq 0 ]; then
  SCENES=(demo picker run-screen)
fi
MAX_TAKES="${MAX_TAKES:-3}"
PUBLIC="../../docs/public"
README="../../README.md"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The example's dev ports and its proxy's have to be free, or it won't boot cleanly. A port
# that is held is someone's running process: say whose, and stop there rather than kill it.
for port in 3000 3001 3002 21050; do
  holder=$( (lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) | tail -n +2 | awk '{ print $1 " (pid " $2 ")" }' | sort -u | paste -sd, -)
  if [ -n "$holder" ]; then
    echo "error: port $port is in use by $holder; stop it and run this again" >&2
    exit 1
  fi
done

# The example's infra (Postgres, the mail catcher), up and migrated before the recording starts,
# so a recorded startup takes the second it takes on a warm machine.
(cd ../../example && pnpm stackctl infra up)

for scene in "${SCENES[@]}"; do
  cast="$WORK/$scene.cast"
  text="$WORK/$scene.txt"
  kept=""
  for take in $(seq 1 "$MAX_TAKES"); do
    # Forget the remembered selection, so the picker starts empty.
    (cd ../../example && pnpm stackctl --mode development reset >/dev/null)
    if node record.ts "$scene" "$cast" "$text"; then
      kept="$take"
      break
    fi
    echo "$scene: take $take dropped" >&2
  done
  if [ -z "$kept" ]; then
    echo "error: $scene: none of $MAX_TAKES takes passed; its recording is unchanged" >&2
    exit 1
  fi

  if [ "$scene" = demo ]; then
    # The README's GIF: agg renders the cast in the colors it embeds (record.ts), drawing Menlo
    # itself at the weight a terminal draws it. 30px Menlo is an 18px cell: a 2x image, sharp on
    # a retina screen at a terminal's text size. A margin of the terminal's background keeps a
    # rounded frame from clipping a character.
    gif_name="demo-$(date +%s).gif"
    agg --quiet --text-font-family "Menlo" --font-size 30 --line-height 1.2 \
      --idle-time-limit 10 --last-frame-duration 2 --fps-cap 30 "$cast" "$WORK/raw.gif"
    ffmpeg -v error -y -i "$WORK/raw.gif" \
      -vf "pad=iw+56:ih+56:28:28:color=0x24292E,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none" \
      "$WORK/$gif_name"
    if ! node frames.ts "$WORK/$gif_name"; then
      echo "error: frames.ts found a frame that looks off; the demo is unchanged" >&2
      exit 1
    fi
    # Point the README at it, and bail if that didn't take, before the old GIF is dropped.
    mv "$WORK/$gif_name" "$PUBLIC/$gif_name"
    sed -i '' -E "s|public/demo(-[0-9]+)?\.gif|public/$gif_name|g" "$README"
    grep -q "public/$gif_name" "$README" || {
      echo "error: could not find the demo GIF URL to update in README.md" >&2
      exit 1
    }
    find "$PUBLIC" -maxdepth 1 -name 'demo*.gif' ! -name "$gif_name" -delete
  fi

  node place.ts "$scene" "$cast" "$text"
  echo "$scene: take $kept placed"
done
