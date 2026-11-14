import { describe, expect, test } from 'vitest';
import { composeProjectName } from './project-name.js';

describe('composeProjectName', () => {
  test('defaults to the workspace directory name and the profile', () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'development' }),
    ).toBe('example-development');
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'test' })).toBe(
      'example-test',
    );
  });

  test("normalizes to Compose's naming rule: lowercase, [a-z0-9_-] only", () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/My App.v2', profile: 'development' }),
    ).toBe('my-app-v2-development');
  });

  test('strips leading characters that are not a letter or digit', () => {
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/_scratch', profile: 'test' })).toBe(
      'scratch-test',
    );
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/.hidden', profile: 'test' })).toBe(
      'hidden-test',
    );
  });

  test('normalizes a dotted profile name', () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'e2e.ci' }),
    ).toBe('example-e2e-ci');
  });

  test('COMPOSE_PROJECT_NAME from the resolved environment wins, untouched', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: 'custom_name' },
        workspaceDir: '/repos/example',
        profile: 'development',
      }),
    ).toBe('custom_name');
  });

  test('an empty COMPOSE_PROJECT_NAME is ignored', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: '' },
        workspaceDir: '/repos/example',
        profile: 'development',
      }),
    ).toBe('example-development');
  });
});
