import { UnrecoverableError } from 'bullmq';

const permanentErrorCodes = new Set([
  'INVALID_AGENT',
  'INVALID_AGENT_TASK_ID',
  'INVALID_BRANCH',
  'INVALID_TASK_ID',
  'MAIN_WORKTREE_DIRTY',
  'WORKSPACE_HAS_NO_CONTAINER',
  'WORKSPACE_REPOSITORY_NOT_INITIALIZED'
]);

export function jobErrorCode(error: unknown) {
  return error instanceof Error ? error.message.split(':', 1)[0] : undefined;
}

export function isPermanentJobError(error: unknown) {
  return error instanceof UnrecoverableError || permanentErrorCodes.has(jobErrorCode(error) ?? '');
}

export function asBullMqJobError(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error;
  const normalized = error instanceof Error ? error : new Error('JOB_FAILED');
  return isPermanentJobError(normalized) ? new UnrecoverableError(normalized.message) : normalized;
}
