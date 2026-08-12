import { describe, expect, it } from 'vitest';
import { SecretScope } from '@oliveira/database';
import { validateSecretScopeShape } from './secrets.js';

describe('secret scope shape', () => {
  it.each([
    { scope: SecretScope.ORGANIZATION },
    { scope: SecretScope.PROJECT, projectId: 'project-a' },
    { scope: SecretScope.WORKSPACE, workspaceId: 'workspace-a' }
  ])('accepts the one unambiguous resource combination for $scope', input => {
    expect(() => validateSecretScopeShape(input)).not.toThrow();
  });

  it.each([
    { scope: SecretScope.ORGANIZATION, projectId: 'project-a' },
    { scope: SecretScope.ORGANIZATION, workspaceId: 'workspace-a' },
    { scope: SecretScope.PROJECT },
    { scope: SecretScope.PROJECT, projectId: 'project-a', workspaceId: 'workspace-a' },
    { scope: SecretScope.WORKSPACE },
    { scope: SecretScope.WORKSPACE, projectId: 'project-a', workspaceId: 'workspace-a' }
  ])('rejects ambiguous or incomplete input: $scope', input => {
    expect(() => validateSecretScopeShape(input)).toThrow();
  });
});
