#!/usr/bin/env node
// Keeps the docs' TypeScript snippets inside the site's code block, which holds 75 columns
// before it scrolls. The pages are formatted by hand, so this touches the code fences only: a
// `ts` fence with a line over the width is rewritten as oxfmt formats it at that width, with the
// rest of the repo's formatting options.
//
//   pnpm format   # with the rest: rewrite the fences that overflow
//   pnpm lint     # with the rest: `--check`, which rewrites nothing
//   node maintenance/scripts/format-docs-snippets.ts [--check] [page…]   # lint-staged names the staged pages
//
// Either way it lists the lines still over the width and exits 1 if there are any. oxfmt breaks
// code, not comments: a line listed after a rewrite has a trailing comment to move above it, or
// is in a fence oxfmt can't parse, to wrap by hand.
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'oxfmt';
import config from '../../oxfmt.config.ts';

/** Columns of the site's 14px monospace in a page's 688px block, less its 24px paddings. */
const WIDTH = 75;
const LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx']);

const root = path.join(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const check = args.includes('--check');
/** The pages named on the command line, from the repo's root. None named means every page. */
const named = args
  .filter((arg) => !arg.startsWith('--'))
  .map((arg) => path.relative(root, path.resolve(arg)));
const { ignorePatterns: _ignored, overrides: _overrides, ...options } = config;

/**
 * The README and the site's pages, with the home page's example (a glob skips dot directories).
 * The home page's block is narrower than a page's, about 63 columns beside its text: its example
 * is kept shorter than that by hand.
 */
function pages(): string[] {
  const docs = fs
    .globSync('docs/**/*.md', {
      cwd: root,
      exclude: ['docs/architecture/**', 'docs/superpowers/**'],
    })
    .toSorted();
  const all = ['README.md', 'docs/.vitepress/theme/HomeConfig.md', ...docs];
  return named.length === 0 ? all : all.filter((page) => named.includes(page));
}

async function formatAt(code: string, language: string, width: number): Promise<string | null> {
  const result = await format(`snippet.${language}`, code, { ...options, printWidth: width });
  return result.errors.length > 0 ? null : result.code;
}

/** A snippet that opens with `key:`, after any comment lines: a part of a config. */
const PROPERTIES = /^(?:\s*\/\/.*\n)*\s*(?:[\w$]+|'[^']*'|"[^"]*"):\s/;

/**
 * A fence's code at the width, or null for one oxfmt can't parse, which stays as written. Most
 * fences are a part of a config (`api: { port: 3001 },`), which is no program on its own, or
 * worse, is one: a label and a block. Those are formatted as the properties of an object, two
 * columns in.
 */
async function formatSnippet(code: string, language: string): Promise<string | null> {
  if (!PROPERTIES.test(code)) {
    return formatAt(code, language, WIDTH);
  }
  const wrapped = await formatAt(`x = {\n${code}};\n`, language, WIDTH + 2);
  if (wrapped === null) {
    return null;
  }
  const lines = wrapped.split('\n').slice(1, -2);
  // A template literal that runs over lines has lines of its own, with no indent to take off.
  if (lines.some((line) => (line.match(/`/g)?.length ?? 0) % 2 === 1)) {
    return null;
  }
  const properties = `${lines.map((line) => line.slice(2)).join('\n')}\n`;
  // The object's last property gets a trailing comma; a snippet written without one keeps its end.
  return /,\s*(\/\/.*)?\n$/.test(code)
    ? properties
    : properties.replace(/,(\s*(\/\/.*)?\n)$/, '$1');
}

let overflowing = 0;
for (const page of pages()) {
  const file = path.join(root, page);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const language = /^```(\w+)/.exec(lines[i]!)?.[1];
    const end = language === undefined ? -1 : lines.indexOf('```', i + 1);
    if (language === undefined || !LANGUAGES.has(language) || end === -1) {
      out.push(lines[i]!);
      continue;
    }
    let body = lines.slice(i + 1, end);
    if (!check && body.some((line) => line.length > WIDTH)) {
      const formatted = await formatSnippet(`${body.join('\n')}\n`, language);
      body = formatted?.split('\n').slice(0, -1) ?? body;
    }
    for (const [offset, line] of body.entries()) {
      if (line.length > WIDTH) {
        overflowing++;
        console.error(`${page}:${i + 2 + offset}  ${line.length} columns  ${line.trim()}`);
      }
    }
    out.push(lines[i]!, ...body, '```');
    i = end;
  }
  if (!check && out.join('\n') !== lines.join('\n')) {
    fs.writeFileSync(file, out.join('\n'));
    console.log(`formatted ${page}`);
  }
}

if (overflowing > 0) {
  console.error(`\n${overflowing} snippet line(s) over ${WIDTH} columns.`);
  process.exit(1);
}
