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
# Requires: brew install agg ffmpeg gifsicle, python3 (for the e2e suite's PTY driver), and Docker for the
# example's infra. The recording drives the real example (Go worker + Vite frontend), so a plain
# `pnpm stackctl` must boot cleanly here first, with its ports (21060, 3001, 3002, 21050) free. It never
# touches the clipboard (see record.ts).
set -euo pipefail
cd "$(dirname "$0")"

SCENES=("$@")
if [ ${#SCENES[@]} -eq 0 ]; then
  SCENES=(demo picker run-screen getting-started agent-restart agent-tests)
fi
MAX_TAKES="${MAX_TAKES:-3}"
PUBLIC="../../docs/public"
README="../../README.md"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The example's dev ports and its proxy's have to be free, or it won't boot cleanly. A port
# that is held is someone's running process: say whose, and stop there rather than kill it.
for port in 21060 3001 3002 21050; do
  holder=$( (lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) | tail -n +2 | awk '{ print $1 " (pid " $2 ")" }' | sort -u | paste -sd, -)
  if [ -n "$holder" ]; then
    echo "error: port $port is in use by $holder; stop it and run this again" >&2
    exit 1
  fi
done

# A session started at a terminal offers the agent guidance once. The recordings are of a
# workspace where that was already answered, so the example is marked as having said no.
mkdir -p ../../example/node_modules/.stackctl
printf '{ "declined": true }\n' > ../../example/node_modules/.stackctl/agent-guidance.json

# The example's infra (Postgres, the mail catcher), up and migrated before the recording starts,
# so a recorded startup takes the second it takes on a warm machine.
(cd ../../example && pnpm stackctl infra start)

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
    # a retina screen at a terminal's text size. A margin of the terminal's background keeps the
    # rounded corners from clipping a character. The corners are the site player's 12px at 2x,
    # made transparent so they round on GitHub's and npm's light and dark pages alike.
    # Transparency turns off ffmpeg's frame-to-frame compression; gifsicle puts it back.
    # Menlo has no rounded box corners (╭╮╰╯), and agg's fallback draws them small and off the
    # lines, so the GIF's boxes take Menlo's square ones. The site's player draws its own.
    gif_name="demo-$(date +%s).gif"
    sed 's/╭/┌/g; s/╮/┐/g; s/╰/└/g; s/╯/┘/g' "$cast" > "$WORK/gif.cast"
    agg --quiet --text-font-family "Menlo" --font-size 30 --line-height 1.2 \
      --idle-time-limit 10 --last-frame-duration 2 --fps-cap 30 "$WORK/gif.cast" "$WORK/raw.gif"
    radius=24
    corners="if(gt(abs(W/2-X),W/2-$radius)*gt(abs(H/2-Y),H/2-$radius),if(lte(hypot($radius-(W/2-abs(W/2-X)),$radius-(H/2-abs(H/2-Y))),$radius),255,0),255)"
    ffmpeg -v error -y -i "$WORK/raw.gif" \
      -vf "pad=iw+56:ih+56:28:28:color=0x24292E,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='$corners',split[a][b];[a]palettegen=max_colors=256:reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=dither=none:alpha_threshold=128" \
      "$WORK/rounded.gif"
    gifsicle -O3 "$WORK/rounded.gif" -o "$WORK/$gif_name"
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
