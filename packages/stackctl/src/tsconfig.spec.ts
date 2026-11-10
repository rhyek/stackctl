import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { reconcileTsconfigText, reconcileTsconfig } from './tsconfig.js';

const CFG = 'stackctl.config.ts';

describe('reconcileTsconfigText', () => {
  test('creates a full tsconfig (with types:["node"] and the config in include) when none exists', () => {
    const { text, outcome } = reconcileTsconfigText(null, CFG);
    expect(outcome).toBe('created');
    const cfg = parse(text) as {
      compilerOptions: { types: string[]; strict?: boolean; noEmit?: boolean };
      include: string[];
    };
    expect(cfg.compilerOptions.types).toEqual(['node']);
    expect(cfg.include).toEqual([CFG]);
    expect(cfg.compilerOptions.strict).toBe(true);
    expect(cfg.compilerOptions.noEmit).toBe(true);
  });

  test('uses the given config filename in a created tsconfig', () => {
    const { text } = reconcileTsconfigText(null, 'stackctl.config.mts');
    expect((parse(text) as { include: string[] }).include).toEqual(['stackctl.config.mts']);
  });

  test('adds an include array when the existing config has none', () => {
    const { text, outcome } = reconcileTsconfigText('{}', CFG);
    expect(outcome).toBe('updated');
    expect((parse(text) as { include: string[] }).include).toEqual([CFG]);
  });

  test('appends to an existing include array without dropping entries', () => {
    const { text } = reconcileTsconfigText('{ "include": ["src"] }', CFG);
    expect((parse(text) as { include: string[] }).include).toEqual(['src', CFG]);
  });

  test('is a no-op when the config is already in include', () => {
    const input = '{\n  "include": ["stackctl.config.ts"]\n}\n';
    const { text, outcome } = reconcileTsconfigText(input, CFG);
    expect(outcome).toBe('unchanged');
    expect(text).toBe(input);
  });

  test('adds "node" to a types array that omits it', () => {
    const { text } = reconcileTsconfigText('{ "compilerOptions": { "types": ["vitest"] } }', CFG);
    const cfg = parse(text) as { compilerOptions: { types: string[] }; include: string[] };
    expect(cfg.compilerOptions.types).toEqual(['vitest', 'node']);
    expect(cfg.include).toEqual([CFG]);
  });

  test('leaves types alone when it is absent entirely', () => {
    const { text } = reconcileTsconfigText('{ "compilerOptions": { "strict": true } }', CFG);
    const cfg = parse(text) as { compilerOptions: Record<string, unknown> };
    expect('types' in cfg.compilerOptions).toBe(false);
  });

  test('does not touch a types array that already has "node"', () => {
    const input = '{ "compilerOptions": { "types": ["node"] }, "include": ["stackctl.config.ts"] }';
    expect(reconcileTsconfigText(input, CFG).outcome).toBe('unchanged');
  });

  test('preserves comments in an existing JSONC tsconfig', () => {
    const input = '{\n  // keep me\n  "compilerOptions": { "types": ["vitest"] }\n}\n';
    const { text } = reconcileTsconfigText(input, CFG);
    expect(text).toContain('// keep me');
    const cfg = parse(text) as { compilerOptions: { types: string[] }; include: string[] };
    expect(cfg.compilerOptions.types).toEqual(['vitest', 'node']);
    expect(cfg.include).toEqual([CFG]);
  });

  test('is idempotent — a second pass makes no further change', () => {
    const first = reconcileTsconfigText(
      '{ "include": ["src"], "compilerOptions": { "types": ["a"] } }',
      CFG,
    );
    const second = reconcileTsconfigText(first.text, CFG);
    expect(second.outcome).toBe('unchanged');
    expect(second.text).toBe(first.text);
    expect((parse(second.text) as { include: string[] }).include).toEqual(['src', CFG]);
  });

  test('leaves an unparseable tsconfig untouched', () => {
    const { text, outcome } = reconcileTsconfigText('this is not json', CFG);
    expect(outcome).toBe('unchanged');
    expect(text).toBe('this is not json');
  });
});

describe('reconcileTsconfig (fs)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-tsconfig-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('creates tsconfig.json when missing', () => {
    expect(reconcileTsconfig({ cwd })).toBe('created');
    const cfg = parse(fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8')) as {
      include: string[];
    };
    expect(cfg.include).toEqual([CFG]);
  });

  test('updates an existing tsconfig.json and is idempotent on re-run', () => {
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{ "include": ["src"] }\n');
    expect(reconcileTsconfig({ cwd })).toBe('updated');
    expect(reconcileTsconfig({ cwd })).toBe('unchanged');
    const cfg = parse(fs.readFileSync(path.join(cwd, 'tsconfig.json'), 'utf8')) as {
      include: string[];
    };
    expect(cfg.include).toEqual(['src', CFG]);
  });
});
