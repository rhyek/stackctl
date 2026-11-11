#!/usr/bin/env node
// Lists the recordings (scenes.ts) that a change may alter: every scene one of whose `triggers`
// matches a changed file, with the files that matched. The /commit skill runs it before a commit,
// and the commit hook (.claude/hooks/check-recordings.ts) imports it.
//
//   node scripts/demo/affected.ts            # the working tree against HEAD, untracked files too
//   node scripts/demo/affected.ts <ref>      # the working tree against <ref> (e.g. origin/main)
//
// Tests (`*.spec.ts(x)`, `*.test-d.ts`) never count. A match means "may alter": whether the change
// really reaches the screen is for whoever reads the diff to judge. Prints nothing when no scene
// is affected.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { scenes } from './scenes.ts';

/**
 * Every file the working tree at `root` (this checkout by default) changes against `base`,
 * untracked ones included, from the repo's root.
 */
export function changedFiles(
  base = 'HEAD',
  root = path.resolve(import.meta.dirname, '../..'),
): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [
    ...new Set([
      ...git('diff', '--name-only', base),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ];
}

export interface Affected {
  scene: string;
  description: string;
  /** The changed files that matched its triggers. */
  files: string[];
}

/** The scenes whose triggers match one of `changed`, tests left out. */
export function affectedScenes(changed: string[]): Affected[] {
  const counted = changed.filter((file) => !/\.(spec\.tsx?|test-d\.ts)$/.test(file));
  return Object.entries(scenes).flatMap(([scene, { description, triggers }]) => {
    const files = counted.filter((file) => triggers.some((glob) => path.matchesGlob(file, glob)));
    return files.length > 0 ? [{ scene, description, files }] : [];
  });
}

if (import.meta.main) {
  for (const { scene, description, files } of affectedScenes(changedFiles(process.argv[2]))) {
    console.log(`${scene}: ${description}`);
    for (const file of files) {
      console.log(`  ${file}`);
    }
  }
}
