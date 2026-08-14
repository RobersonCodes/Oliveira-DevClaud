import type { DeadLetterQueue, Prisma, PrismaClient } from '@oliveira/database';
import { jobErrorCode } from './jobErrors.js';

export function sanitizedPermanentErrorCode(error: unknown) {
  const code = jobErrorCode(error) ?? 'PERMANENT_JOB_FAILURE';
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(code) ? code : 'PERMANENT_JOB_FAILURE';
}

export async function recordPermanentJobFailure(input: {
  database: PrismaClient;
  queue: DeadLetterQueue;
  organizationId: string;
  workspaceId?: string | null;
  sourceId: string;
  sourceJobId: string;
  payload: Record<string, string>;
  attempts: number;
  error: unknown;
}) {
  const errorCode = sanitizedPermanentErrorCode(input.error);
  return input.database.deadLetterJob.upsert({
    where: {
      organizationId_queue_sourceId_sourceJobId: {
        organizationId: input.organizationId,
        queue: input.queue,
        sourceId: input.sourceId,
        sourceJobId: input.sourceJobId
      }
    },
    create: {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      queue: input.queue,
      sourceId: input.sourceId,
      sourceJobId: input.sourceJobId,
      payload: input.payload as Prisma.InputJsonValue,
      errorCode,
      attempts: Math.max(1, input.attempts)
    },
    update: { errorCode, attempts: Math.max(1, input.attempts) }
  });
}
