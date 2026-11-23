import { describe, expect, test } from 'vitest';
import { UnknownTagError, selectByTags } from './tags';

const known = [
  { name: 'api', tags: ['backend'] },
  { name: 'web', tags: ['frontend'] },
  { name: 'worker', tags: ['backend', 'jobs'] },
  { name: 'docs', tags: [] },
];

describe('selectByTags', () => {
  test("a tag is every known name that has it, in known's order", () => {
    const result = selectByTags(known, { names: [], tags: ['backend'] }, 'service');
    expect(result.names).toEqual(['api', 'worker']);
    expect([...result.fromTagOnly]).toEqual(['api', 'worker']);
  });

  test('several tags, and names with tags, are a union without repeats', () => {
    const result = selectByTags(
      known,
      { names: ['worker', 'web'], tags: ['backend', 'jobs'] },
      'service',
    );
    expect(result.names).toEqual(['api', 'web', 'worker']);
    expect([...result.fromTagOnly]).toEqual(['api']);
  });

  test('a name known lacks is kept, after the known ones', () => {
    const result = selectByTags(known, { names: ['nope', 'web'], tags: [] }, 'service');
    expect(result.names).toEqual(['web', 'nope']);
    expect(result.fromTagOnly.size).toBe(0);
  });

  test('a tag nothing has throws UnknownTagError naming it', () => {
    const select = (tags: string[], kind: 'service' | 'infra service') => () =>
      selectByTags(known, { names: [], tags }, kind);
    expect(select(['backend', 'x', 'y'], 'service')).toThrow(UnknownTagError);
    expect(select(['backend', 'x', 'y'], 'service')).toThrow('No service has the tags: x, y');
    expect(select(['x'], 'service')).toThrow('No service has the tag: x');
    expect(select(['x'], 'infra service')).toThrow('No infra service has the tag: x');
    expect(select(['x', 'x'], 'service')).toThrow('No service has the tag: x');
  });

  test('no tags and no names is an empty selection', () => {
    const result = selectByTags(known, { names: [], tags: [] }, 'service');
    expect(result.names).toEqual([]);
    expect(result.fromTagOnly.size).toBe(0);
  });
});
