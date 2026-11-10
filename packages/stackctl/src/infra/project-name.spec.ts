import { describe, expect, test } from 'vitest';
import { composeProjectName } from './project-name.js';

describe('composeProjectName', () => {
  test('defaults to the workspace directory name and the mode', () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/example', mode: 'development' }),
    ).toBe('example-development');
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/example', mode: 'test' })).toBe(
      'example-test',
    );
  });

  test("normalizes to Compose's naming rule: lowercase, [a-z0-9_-] only", () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/My App.v2', mode: 'development' }),
    ).toBe('my-app-v2-development');
  });

  test('strips leading characters that are not a letter or digit', () => {
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/_scratch', mode: 'test' })).toBe(
      'scratch-test',
    );
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/.hidden', mode: 'test' })).toBe(
      'hidden-test',
    );
  });

  test('normalizes a dotted mode name', () => {
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/example', mode: 'e2e.ci' })).toBe(
      'example-e2e-ci',
    );
  });

  test('COMPOSE_PROJECT_NAME from the resolved environment wins, untouched', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: 'custom_name' },
        workspaceDir: '/repos/example',
        mode: 'development',
      }),
    ).toBe('custom_name');
  });

  test('an empty COMPOSE_PROJECT_NAME is ignored', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: '' },
        workspaceDir: '/repos/example',
        mode: 'development',
      }),
    ).toBe('example-development');
  });
});
