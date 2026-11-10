import chalk from 'chalk';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { stripAnsi } from './format.js';
import {
  createFormatter,
  defaultFormatter,
  pinoLevels,
  winstonLevels,
  logging,
} from './log-formatter.js';

// Semantic tests assert the text; strip color so they're independent of the env's chalk.level.
const fmt = (config?: Parameters<typeof createFormatter>[0]) => {
  const f = createFormatter(config);
  return (line: string) => stripAnsi(f(line));
};

describe('createFormatter', () => {
  describe('logging namespace', () => {
    test('exposes the base factory, the default, and the ecosystem helpers', () => {
      expect(logging.formatter).toBe(createFormatter);
      expect(logging.nodejs.pino.levels).toBe(pinoLevels);
      expect(logging.nodejs.winston.levels).toBe(winstonLevels);
      // defaultFormatter is a plain createFormatter() — used automatically on every package.
      expect(stripAnsi(defaultFormatter('{"level":"info","msg":"hi"}'))).toBe('[INFO] hi');
    });
  });

  describe('pass-through', () => {
    const f = fmt();

    test('returns a non-JSON line unchanged', () => {
      expect(f('not json at all')).toBe('not json at all');
      expect(f('[vite] ready in 431 ms')).toBe('[vite] ready in 431 ms');
    });

    test('returns non-object JSON (array, number, string, null) unchanged', () => {
      expect(f('[1,2,3]')).toBe('[1,2,3]');
      expect(f('42')).toBe('42');
      expect(f('null')).toBe('null');
    });

    test('returns a JSON object with no level/message unchanged', () => {
      expect(f('{"foo":1,"bar":2}')).toBe('{"foo":1,"bar":2}');
    });
  });

  describe('rendering — [LEVEL] message + indented properties', () => {
    const f = fmt();

    test('renders a slog line as a bracketed header plus indented properties', () => {
      expect(f('{"level":"INFO","msg":"hello world","port":"3002"}')).toBe(
        '[INFO] hello world\n  port: 3002',
      );
    });

    test('preserves property order and renders non-string values as JSON', () => {
      expect(f('{"level":"INFO","msg":"hi","count":3,"meta":{"a":1}}')).toBe(
        '[INFO] hi\n  count: 3\n  meta: {"a":1}',
      );
    });

    test('handles a level with no message, and a message with no level', () => {
      expect(f('{"level":"INFO","port":1}')).toBe('[INFO]\n  port: 1');
      expect(f('{"msg":"hi","x":1}')).toBe('hi\n  x: 1');
    });
  });

  describe('level matching (case-insensitive, aliases → canonical)', () => {
    const f = fmt();

    test('uppercases and matches string levels', () => {
      expect(f('{"level":"info","msg":"x"}')).toBe('[INFO] x');
      expect(f('{"level":"Warn","msg":"x"}')).toBe('[WARN] x');
    });

    test('folds aliases onto the canonical level', () => {
      expect(f('{"level":"warning","msg":"x"}')).toBe('[WARN] x'); // WARNING → WARN
      expect(f('{"level":"err","msg":"x"}')).toBe('[ERROR] x'); // ERR → ERROR
      expect(f('{"level":"critical","msg":"x"}')).toBe('[FATAL] x'); // CRITICAL → FATAL
    });

    test('marks an unmatched string level unknown (uppercased)', () => {
      expect(f('{"level":"audit","msg":"x"}')).toBe('[UNKNOWN LOGLVL: AUDIT] x');
    });

    test('never guesses a numeric level — unknown without a map', () => {
      expect(f('{"level":30,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 30] x');
    });
  });

  describe('config shape { fields, levels }', () => {
    test('reads level/message/custom under `fields` and the map under `levels`', () => {
      const f2 = fmt({
        fields: { level: 'lvl', message: 'text', custom: { t: { show: false } } },
        levels: { 5: 'error' },
      });
      expect(f2('{"lvl":5,"text":"boom","t":"hidden","a":2}')).toBe('[ERROR] boom\n  a: 2');
    });
  });

  describe('custom (rename / hide)', () => {
    test('renames via the string shorthand and the long form', () => {
      expect(fmt({ fields: { custom: { timestamp: 'ts' } } })('{"level":"INFO","msg":"hi","ts":"T"}')).toBe('[INFO] hi\n  timestamp: T'); // oxfmt-ignore
      expect(fmt({ fields: { custom: { timestamp: { source: 'ts' } } } })('{"level":"INFO","msg":"hi","ts":"T"}')).toBe('[INFO] hi\n  timestamp: T'); // oxfmt-ignore
    });

    test('hides a property with { show: false }', () => {
      expect(fmt({ fields: { custom: { time: { show: false } } } })('{"level":"INFO","msg":"hi","time":"T","port":1}')).toBe('[INFO] hi\n  port: 1'); // oxfmt-ignore
    });
  });

  describe('config as a callback', () => {
    test('decides the mapping from the parsed log itself', () => {
      // `at` is only noise on healthcheck events; keep it everywhere else.
      const f = fmt((log) => ({
        fields: {
          custom: {
            time: { show: false },
            ...(log.context === 'healthcheck' ? { at: { show: false } } : {}),
          },
        },
      }));
      expect(f('{"level":"INFO","msg":"pong","context":"healthcheck","at":"T","peer":"web"}')).toBe('[INFO] pong\n  context: healthcheck\n  peer: web'); // oxfmt-ignore
      expect(f('{"level":"INFO","msg":"started","context":"bridge","at":"T"}')).toBe('[INFO] started\n  context: bridge\n  at: T'); // oxfmt-ignore
      // the unconditionally-hidden field stays hidden in both branches
      expect(f('{"level":"INFO","msg":"hi","time":"T"}')).toBe('[INFO] hi');
    });

    test('re-runs per line, and supports renaming from it', () => {
      const seen: unknown[] = [];
      const f = fmt((log) => {
        seen.push(log.context);
        return { fields: log.context === 'ingest' ? { custom: { when: 'at' } } : {} };
      });
      expect(f('{"level":"INFO","msg":"a","context":"ingest","at":"T"}')).toBe('[INFO] a\n  context: ingest\n  when: T'); // oxfmt-ignore
      expect(f('{"level":"INFO","msg":"b","context":"other","at":"T"}')).toBe('[INFO] b\n  context: other\n  at: T'); // oxfmt-ignore
      expect(seen).toEqual(['ingest', 'other']);
    });

    test('receives the parsed log, never the raw line', () => {
      const seen: unknown[] = [];
      const f = fmt((log) => {
        seen.push(log);
        return {};
      });
      f('{"level":"INFO","msg":"hi","port":8080}');
      expect(seen).toEqual([{ level: 'INFO', msg: 'hi', port: 8080 }]);
    });

    test('can decide the level/message keys and the level map per line', () => {
      // Two sources multiplexed onto one stream, told apart by a marker field.
      const f = fmt((log) =>
        log.src === 'pino' ? { levels: pinoLevels } : { fields: { level: 'lvl', message: 'text' } },
      );
      expect(f('{"src":"pino","level":50,"msg":"down"}')).toBe('[ERROR] down\n  src: pino');
      expect(f('{"src":"go","lvl":"WARN","text":"slow"}')).toBe('[WARN] slow\n  src: go');
    });

    test('is not invoked for a line that is not a JSON object', () => {
      let calls = 0;
      const f = fmt(() => {
        calls++;
        return {};
      });
      expect(f('not json at all')).toBe('not json at all');
      expect(f('[1,2,3]')).toBe('[1,2,3]');
      expect(calls).toBe(0);
    });

    test('is invoked for a JSON object with no level/message, which still passes through', () => {
      // It picks the level/message keys, so it has to run before that guard can be applied.
      let calls = 0;
      const f = fmt(() => {
        calls++;
        return {};
      });
      expect(f('{"foo":1}')).toBe('{"foo":1}');
      expect(calls).toBe(1);
    });
  });

  describe('ecosystem helpers with a callback config', () => {
    test('keeps the pino level map when the config is a callback', () => {
      const f = (line: string) =>
        stripAnsi(logging.nodejs.pino.formatter((log) => ({ fields: { custom: { pid: { show: log.pid !== 0 } } } }))(line)); // oxfmt-ignore
      expect(f('{"level":30,"msg":"up","pid":0}')).toBe('[INFO] up');
      expect(f('{"level":30,"msg":"up","pid":7}')).toBe('[INFO] up\n  pid: 7');
    });

    test("keeps winston's message key when the config is a callback", () => {
      const f = (line: string) => stripAnsi(logging.nodejs.winston.formatter(() => ({}))(line));
      expect(f('{"level":"warn","message":"careful","a":1}')).toBe('[WARN] careful\n  a: 1');
    });
  });

  describe('multi-line values', () => {
    const f = fmt();

    test("aligns a multi-line property value's continuation lines under the value", () => {
      const line = JSON.stringify({
        level: 'INFO',
        msg: 'query executed',
        table: 'users',
        sql: 'SELECT id, email\nFROM users',
      });
      expect(f(line)).toBe(
        '[INFO] query executed\n' +
          '  table: users\n' +
          '  sql: SELECT id, email\n' +
          '       FROM users', // aligned under the value, past "  sql: "
      );
    });

    test('sizes the alignment to the property name', () => {
      const line = JSON.stringify({ level: 'INFO', msg: 'm', context: 'a\nb' });
      // "  context: " is 11 wide, so the continuation gets 11 spaces.
      expect(f(line)).toBe('[INFO] m\n  context: a\n           b');
    });

    test('indents a multi-line message so it stays part of the entry', () => {
      const line = JSON.stringify({ level: 'ERROR', msg: 'boom\n  at foo()\n  at bar()' });
      expect(f(line)).toBe('[ERROR] boom\n    at foo()\n    at bar()');
    });

    test('leaves blank lines blank rather than padding them out', () => {
      const line = JSON.stringify({ level: 'INFO', msg: 'm', text: 'a\n\nb' });
      expect(f(line)).toBe('[INFO] m\n  text: a\n\n        b');
    });

    test('every continuation line starts with whitespace, so stackctl groups them', () => {
      const line = JSON.stringify({ level: 'INFO', msg: 'm', text: 'a\nb\nc' });
      const [, ...rest] = f(line).split('\n');
      expect(rest.every((l) => /^\s/.test(l))).toBe(true);
    });
  });

  describe('logging.nodejs.pino.formatter', () => {
    test('maps pino numeric levels to canonical levels', () => {
      const f2 = (line: string) => stripAnsi(logging.nodejs.pino.formatter()(line));
      expect(f2('{"level":30,"msg":"hi","reqId":"a"}')).toBe('[INFO] hi\n  reqId: a');
      expect(f2('{"level":60,"msg":"boom"}')).toBe('[FATAL] boom');
      expect(f2('{"level":99,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 99] x'); // unmapped stays unknown
    });
  });

  describe('logging.nodejs.winston.formatter', () => {
    const f2 = (line: string) => stripAnsi(logging.nodejs.winston.formatter()(line));
    test("uses winston's `message` key and level names", () => {
      expect(f2('{"level":"warn","message":"careful","code":5}')).toBe('[WARN] careful\n  code: 5');
      expect(f2('{"level":"http","message":"GET /"}')).toBe('[DEBUG] GET /'); // http → DEBUG
    });
  });

  describe('coloring', () => {
    const original = chalk.level;
    beforeAll(() => {
      chalk.level = 3; // force truecolor so the tokens actually carry ANSI
    });
    afterAll(() => {
      chalk.level = original;
    });

    test('colors the bracketed token of a matched level, leaves unknown uncolored', () => {
      expect(createFormatter()('{"level":"error","msg":"boom"}')).toBe(`${chalk.red('[ERROR]')} boom`); // oxfmt-ignore
      expect(createFormatter()('{"level":"info","msg":"ok"}')).toBe(`${chalk.green('[INFO]')} ok`);
      expect(createFormatter()('{"level":30,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 30] x'); // uncolored
    });

    test('colors property keys distinctly from their (plain) values', () => {
      expect(createFormatter()('{"level":"info","msg":"hi","count":1}')).toBe(
        `${chalk.green('[INFO]')} hi\n  ${chalk.gray('count:')} 1`,
      );
    });
  });
});
