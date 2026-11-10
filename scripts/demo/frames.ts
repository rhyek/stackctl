#!/usr/bin/env node
// Frame-by-frame inspection of a recorded demo GIF, for the class of bug you can only see
// one frame at a time: the recorder photographing the terminal mid-repaint, so the frame
// shows the top of the screen redrawn and everything below it still blank.
//
//   node scripts/demo/frames.ts            # newest docs/public/demo-*.gif
//   node scripts/demo/frames.ts path.gif
//
// It writes every frame to scripts/demo/.frames/ (gitignored) so a suspect one can be
// opened directly, and prints two measurements per frame:
//
//   * footer-blank runs — frames where the bottom quarter of the screen has no text at
//     all. In the run phase that means a half-applied repaint. At the very start and at
//     the very end it's just stackctl entering and leaving the alternate screen, which is
//     normal and is labelled as such.
//   * ink dips — frames carrying much less text than their neighbours. A mid-repaint frame
//     lands near 30% of normal; applying or clearing the filter is a genuine content change
//     and sits around 50%; ordinary scrolling stays above 70%.
//
// Ink is measured by thresholding luma (text is bright, the theme background is not) and
// averaging — one ffmpeg pass over the whole GIF, rather than a per-frame image-tool call.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(demoDir, '../../docs/public');
const framesDir = join(demoDir, '.frames');

/** Luma above which a pixel counts as text: the tape's background sits near 41, its text far above. */
const INK_THRESHOLD = 80;
/** Flag a frame when it carries less than this share of its neighbours' text. */
const DIP_RATIO = 0.65;
/** Frames on each side that a frame is compared against (median, so a burst can't skew it). */
const NEIGHBOURHOOD = 8;

function newestDemoGif(): string {
  // By mtime, not by name: a legacy `demo.gif` alongside a `demo-<ts>.gif` sorts last
  // alphabetically (`.` > `-`) and would shadow the recording that's actually newer.
  const newest = readdirSync(assetsDir)
    .filter((f) => /^demo.*\.gif$/.test(f))
    .map((f) => join(assetsDir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .at(-1);
  if (!newest) {
    throw new Error(`no demo GIF in ${assetsDir} — record one with ./scripts/demo/record.sh`);
  }
  return newest;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Per-frame share of pixels that are text, optionally over just the bottom `cropBottom` of the frame. */
function inkPerFrame(gif: string, label: string, cropBottom?: number): number[] {
  const out = join(framesDir, `.${label}.txt`);
  const crop = cropBottom ? `crop=iw:ih*${cropBottom}:0:ih*${1 - cropBottom},` : '';
  ffmpeg([
    '-i',
    gif,
    '-vf',
    `${crop}format=gray,lutyuv=y='if(gt(val,${INK_THRESHOLD}),255,0)',` +
      `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${out}`,
    '-f',
    'null',
    '-',
  ]);
  return readFileSync(out, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const m = /YAVG=([\d.]+)/.exec(line);
      return m ? [Number(m[1])] : [];
    });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Group consecutive frame numbers into [start, end] runs, so a 6-frame stall reads as one finding. */
function runs(frames: number[]): [number, number][] {
  const grouped: [number, number][] = [];
  for (const n of frames) {
    const last = grouped[grouped.length - 1];
    if (last && n === last[1] + 1) {
      last[1] = n;
    } else {
      grouped.push([n, n]);
    }
  }
  return grouped;
}

/**
 * The stretch of frames stackctl owns the screen for. A blank bottom quarter is the signature
 * of a half-painted frame, but it's also just what the terminal looks like before the footer
 * exists (the shell, the selector, the build) and after stackctl leaves the alternate screen.
 * Those two bookend the recording, so trim them and judge only what's between.
 *
 * A bookend only counts if it reaches the very first or last frame. That's deliberate: it errs
 * toward reporting a stretch that isn't really a bookend (a false positive you dismiss by
 * opening the frame) rather than swallowing a real artefact as one.
 */
function runPhase(blankFooter: [number, number][], frameCount: number): [number, number] {
  const first = blankFooter[0];
  const last = blankFooter[blankFooter.length - 1];
  return [
    first && first[0] === 0 ? first[1] + 1 : 0,
    last && last[1] === frameCount - 1 ? last[0] - 1 : frameCount - 1,
  ];
}

const gif = process.argv[2] ? resolve(process.argv[2]) : newestDemoGif();

rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
ffmpeg(['-y', '-i', gif, '-vsync', '0', '-start_number', '0', join(framesDir, 'f_%04d.png')]);

// ffprobe reports a GIF's rate as a rational ("25/1"). It can't always derive one — the
// timestamps in the report are cosmetic, so fall back rather than printing NaN everywhere.
const [num = 0, den = 0] = execFileSync(
  'ffprobe',
  [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=avg_frame_rate',
    '-of',
    'csv=p=0',
    gif,
  ],
  { encoding: 'utf8' },
)
  .trim()
  .split('/')
  .map(Number);
const fps = den > 0 && num > 0 ? num / den : 25;
const at = (n: number) => `${(n / fps).toFixed(2)}s`;
const png = (n: number) => join(framesDir, `f_${String(n).padStart(4, '0')}.png`);

const ink = inkPerFrame(gif, 'ink');
const footerInk = inkPerFrame(gif, 'footer', 0.25);

console.log(gif);
console.log(`${ink.length} frames at ${fps.toFixed(2)} fps (${at(ink.length)})\n`);

const blankFooter = runs(footerInk.flatMap((v, n) => (v === 0 ? [n] : [])));
const [runStart, runEnd] = runPhase(blankFooter, ink.length);
const inRunPhase = (n: number) => n >= runStart && n <= runEnd;

console.log(
  `Run phase (footer on screen): frames ${runStart}-${runEnd}, ${at(runStart)} to ${at(runEnd)}\n`,
);
console.log('Frames with no text in the bottom quarter, inside the run phase:');
const suspect = blankFooter.filter(([start, end]) => inRunPhase(start) || inRunPhase(end));
for (const [start, end] of suspect) {
  const span = start === end ? `frame ${start}` : `frames ${start}-${end}`;
  console.log(
    `  ${span.padEnd(18)} ${at(start)}  ${String(end - start + 1).padStart(3)} frames` +
      `  <- half-applied repaint: ${png(start)}`,
  );
}
if (suspect.length === 0) {
  console.log('  (none — the footer never vanishes mid-run)');
}

// Frames holding much less text than their neighbours. Ranked, because the interesting
// question is always "is the worst one a repaint artefact or a real content change?".
const dips = ink
  .map((v, n) => {
    const around: number[] = [];
    for (let m = n - NEIGHBOURHOOD; m <= n + NEIGHBOURHOOD; m++) {
      const neighbour = ink[m];
      if (m !== n && neighbour !== undefined) {
        around.push(neighbour);
      }
    }
    const ref = median(around);
    return { n, ratio: ref > 0.05 ? v / ref : 1 };
  })
  .filter(({ n, ratio }) => ratio < DIP_RATIO && inRunPhase(n))
  .sort((a, b) => a.ratio - b.ratio);

console.log('\nFrames carrying much less text than their neighbours:');
for (const { n, ratio } of dips.slice(0, 10)) {
  console.log(
    `  frame ${String(n).padStart(4)}  ${at(n)}  ${(ratio * 100).toFixed(0)}% of normal  ${png(n)}`,
  );
}
if (dips.length === 0) {
  console.log(`  (none below ${DIP_RATIO * 100}% — nothing to look at)`);
}
console.log(`\nEvery frame is in ${framesDir}`);
