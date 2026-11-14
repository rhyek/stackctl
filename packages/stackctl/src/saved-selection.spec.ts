import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { defineConfig } from './config.js';
import { getStateDir, profileStateDir } from './log-files.js';
import {
  saveSelection,
  resolveSelectedNames,
  readSelection,
  initialPhaseFor,
} from './saved-selection.js';

describe('state + persistence', () => {
  /** The saved selection's current names, or `null` when nothing was saved. */
  const savedNames = () => readSelection()?.names ?? null;
  /** The active profile's saved selection, its folder made. */
  const selectionPath = () => {
    fs.mkdirSync(profileStateDir(process.cwd()), { recursive: true });
    return path.join(profileStateDir(process.cwd()), 'selection.json');
  };

  test("saves the selection in the profile's own folder", () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {} } });
    const file = path.join(getStateDir(), 'profiles', 'development', 'selection.json');
    fs.rmSync(file, { force: true });
    saveSelection(['web']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(['web']);
    fs.rmSync(file);
  });

  /** Deletes the saved selection, as a fresh workspace has none. */
  const clearSelection = () => fs.rmSync(selectionPath(), { force: true });

  test('round-trips the saved selection', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, backend: {} } });
    clearSelection();
    expect(savedNames()).toBeNull();
    saveSelection(['web', 'backend']);
    expect(savedNames()).toEqual(['web', 'backend']);
    clearSelection();
    expect(savedNames()).toBeNull();
  });

  // A saved selection outlives package renames. A name that no longer exists must never reach
  // the picker or `findService` (which throws), and must never be written back.
  test('drops saved names that are not current packages, keeping the valid ones', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, api: {} } });
    fs.writeFileSync(selectionPath(), JSON.stringify(['@old/name', 'web']));
    expect(savedNames()).toEqual(['web']);
    // and the file itself is pruned, so the stale name doesn't linger until the next save
    expect(JSON.parse(fs.readFileSync(selectionPath(), 'utf8'))).toEqual(['web']);
    clearSelection();
  });

  test('never saves a name that is not a current package', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, api: {} } });
    saveSelection(['web', 'api']);
    // The config renames `api` → `backend`; the next run saves what it ran with.
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, backend: {} } });
    saveSelection(savedNames() ?? []);
    expect(JSON.parse(fs.readFileSync(selectionPath(), 'utf8'))).toEqual(['web']); // oxfmt-ignore
    saveSelection(['web', 'api']);
    expect(savedNames()).toEqual(['web']);
    clearSelection();
  });

  test('readSelection separates current names from stale ones, pruning the file', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, api: {} } });
    fs.writeFileSync(selectionPath(), JSON.stringify(['@old/name', 'web', '@gone/too']));
    expect(readSelection()).toEqual({ names: ['web'], stale: ['@old/name', '@gone/too'] });
    expect(savedNames()).toEqual(['web']);
    clearSelection();
    expect(readSelection()).toBeNull();
  });

  // Renamed package keys must never stop stackctl from running: a stale saved name sends the
  // TUI back to the picker (known names preselected) instead of skipping it on --last-answers.
  test('a stale saved name forces the picker even with --last-answers, preselecting the rest', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {}, api: {} } });
    fs.writeFileSync(selectionPath(), JSON.stringify(['@old/name', 'web'])); // oxfmt-ignore
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'package-select',
      preselected: ['web'],
    });
    fs.writeFileSync(selectionPath(), JSON.stringify(['web']));
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'run',
      services: ['web'],
    });
    expect(initialPhaseFor({ packages: ['api'], lastAnswers: true })).toEqual({
      type: 'run',
      services: ['api'],
    });
    clearSelection();
    expect(initialPhaseFor({ packages: [], lastAnswers: true })).toEqual({
      type: 'package-select',
      preselected: [],
    });
  });

  test('--last-answers without a picker refuses a selection with stale names, naming them', () => {
    defineConfig({ serviceRootDir: 'packages', services: { web: {} } });
    fs.writeFileSync(selectionPath(), JSON.stringify(['@old/name', 'web'])); // oxfmt-ignore
    expect(resolveSelectedNames({ service: [], lastAnswers: true }, '--headless')).toEqual({
      error:
        'The saved selection names services that no longer exist (@old/name) — run once without --last-answers to pick again.',
    });
    fs.writeFileSync(selectionPath(), JSON.stringify(['@old/name']));
    expect(resolveSelectedNames({ service: [], lastAnswers: true }, '--headless')).toEqual({
      error:
        'The saved selection names services that no longer exist (@old/name) — run once without --last-answers to pick again.',
    });
    fs.writeFileSync(selectionPath(), JSON.stringify(['web']));
    expect(resolveSelectedNames({ service: [], lastAnswers: true }, '--headless')).toEqual({
      names: ['web'],
    });
    clearSelection();
    expect(resolveSelectedNames({ service: [], lastAnswers: true }, '--headless')).toEqual({
      error: 'No saved selection found — run once without --last-answers first.',
    });
  });
});
