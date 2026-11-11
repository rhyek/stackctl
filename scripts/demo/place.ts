#!/usr/bin/env node
// Puts one recorded scene where the docs show it. record.sh runs it after record.ts.
//
//   node scripts/demo/place.ts <scene> <recorded.cast> <recorded.txt>
//
// - **The cast** goes to docs/public/casts/<scene>-<unix-ts>.cast (the timestamp busts caches), and
//   the scene's earlier casts are deleted.
// - **Every reference** to the scene's cast in docs/ (a page's `<TerminalPlayer src="…">`, the home
//   page's `demo.src`) is pointed at the new one. A scene referenced nowhere is an error.
// - **The text copy** a page keeps for llms.txt is rewritten: the fenced block in the `<llm-only>`
//   right after the scene's player gets the scene's snapshot, so what an agent reads is what the
//   recording shows.
//
// A page shows a recording like this:
//
//   <llm-exclude><TerminalPlayer src="/casts/picker-1794362252.cast" label="…" /></llm-exclude>
//   <llm-only>
//
//   ```text
//   …the snapshot…
//   ```
//
//   </llm-only>
import fs from 'node:fs';
import path from 'node:path';

const [scene, castFrom, textFrom] = process.argv.slice(2);
if (!scene || !castFrom || !textFrom || !/^[a-z-]+$/.test(scene)) {
  console.error('usage: node scripts/demo/place.ts <scene> <recorded.cast> <recorded.txt>');
  process.exit(2);
}

const docs = path.resolve(import.meta.dirname, '../../docs');
const castsDir = path.join(docs, 'public/casts');
const name = `${scene}-${Math.floor(Date.now() / 1000)}.cast`;

const pages = fs
  .readdirSync(docs, { recursive: true, encoding: 'utf8' })
  .filter(
    (file) => file.endsWith('.md') && !file.split(path.sep).some((part) => part.startsWith('.')),
  )
  .map((file) => path.join(docs, file));

const reference = new RegExp(`/casts/${scene}(?:-\\d+)?\\.cast`, 'g');
// The scene's player, up to the end of the `<llm-only>` after it, with its fenced text block.
// The block's text never runs past its own `</llm-only>`, so one page's copies can't swallow another's.
const textCopy = new RegExp(
  `(<TerminalPlayer src="/casts/${scene}-\\d+\\.cast"[^>]*/></llm-exclude>\\n<llm-only>\\n\\n\`\`\`text\\n)(?:(?:(?!</llm-only>)[\\s\\S])*?\\n)?(\`\`\`\\n\\n</llm-only>)`,
  'g',
);
const text = fs.readFileSync(textFrom, 'utf8').replace(/\n+$/, '');

let referenced = 0;
for (const page of pages) {
  const before = fs.readFileSync(page, 'utf8');
  let after = before.replace(reference, () => {
    referenced++;
    return `/casts/${name}`;
  });
  after = after.replace(textCopy, (_, open: string, close: string) => `${open}${text}\n${close}`);
  if (after !== before) {
    fs.writeFileSync(page, after);
    console.log(`place.ts: ${scene} -> ${path.relative(docs, page)}`);
  }
}
if (referenced === 0) {
  console.error(`place.ts: nothing in docs/ shows /casts/${scene}.cast`);
  process.exit(1);
}

fs.mkdirSync(castsDir, { recursive: true });
fs.copyFileSync(castFrom, path.join(castsDir, name));
for (const file of fs.readdirSync(castsDir)) {
  if (file !== name && new RegExp(`^${scene}-\\d+\\.cast$`).test(file)) {
    fs.rmSync(path.join(castsDir, file));
  }
}
