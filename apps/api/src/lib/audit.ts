import { prisma } from '@oliveira/database';
export async function audit(data: { userId?: string; organizationId?: string; action: string; resource: string; resourceId?: string; ipAddress?: string; metadata?: Record<string, unknown> }) {
  await prisma.auditLog.create({ data: data as any }).catch(() => undefined);
}
