import { prisma } from '@oliveira/database';

/**
 * General-purpose activity feed (git.changed, build.completed, test.failed, workspace.created, ...) —
 * distinct from audit() in audit.ts, which stays reserved for sensitive/security-relevant actions.
 * Same fire-and-forget shape as audit(): never let a logging failure break the caller's request.
 */
export async function recordActivity(data: { organizationId: string; workspaceId?: string; userId?: string; type: string; message: string; metadata?: Record<string, unknown> }) {
  await prisma.activityLog.create({ data: data as any }).catch(() => undefined);
}
