import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DeadLetterQueue, DeadLetterStatus, prisma, Role, SetupStage } from '@oliveira/database';
import { OrchestrationQueue } from '@oliveira/orchestrator-engine';
import { SetupQueue } from '@oliveira/setup-queue';
import { requireOrgRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

async function loadDeadLetter(request: FastifyRequest, id: string) {
  const deadLetter = await prisma.deadLetterJob.findUnique({ where: { id } });
  if (!deadLetter) throw Object.assign(new Error('DEAD_LETTER_NOT_FOUND'), { statusCode: 404 });
  const auth = await requireOrgRole(request, deadLetter.organizationId, Role.ADMIN);
  return { deadLetter, ...auth };
}

export async function deadLetterRoutes(app: FastifyInstance) {
  const orchestrationQueue = new OrchestrationQueue();
  const setupQueue = new SetupQueue();
  app.addHook('onClose', async () => {
    await Promise.all([orchestrationQueue.queue.close(), setupQueue.close()]);
  });

  app.get('/', async request => {
    const query = z.object({
      organizationId: z.string().cuid(),
      status: z.nativeEnum(DeadLetterStatus).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50)
    }).parse(request.query);
    await requireOrgRole(request, query.organizationId, Role.ADMIN);
    return prisma.deadLetterJob.findMany({
      where: { organizationId: query.organizationId, status: query.status },
      orderBy: { createdAt: 'desc' },
      take: query.limit
    });
  });

  app.post('/:id/resolve', async request => {
    const { id } = request.params as { id: string };
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(request.body);
    const { deadLetter, user } = await loadDeadLetter(request, id);
    if (deadLetter.status === DeadLetterStatus.RESOLVED) return { ok: true, alreadyResolved: true };
    const resolved = await prisma.deadLetterJob.updateMany({
      where: { id, status: DeadLetterStatus.OPEN },
      data: { status: DeadLetterStatus.RESOLVED, resolutionNote: body.note, reviewedById: user.id, reviewedAt: new Date() }
    });
    if (resolved.count === 0) {
      const current = await prisma.deadLetterJob.findUnique({ where: { id }, select: { status: true } });
      if (current?.status === DeadLetterStatus.RESOLVED) return { ok: true, alreadyResolved: true };
      throw Object.assign(new Error('DEAD_LETTER_NOT_RESOLVABLE'), { statusCode: 409 });
    }
    await audit({ userId: user.id, organizationId: deadLetter.organizationId, action: 'DEAD_LETTER_RESOLVED', resource: 'DeadLetterJob', resourceId: id, ipAddress: request.ip, metadata: { queue: deadLetter.queue, sourceId: deadLetter.sourceId } });
    return { ok: true, alreadyResolved: false };
  });

  app.post('/:id/requeue', async request => {
    const { id } = request.params as { id: string };
    const loaded = await loadDeadLetter(request, id);
    let deadLetter = loaded.deadLetter;
    const { user } = loaded;
    if (deadLetter.status === DeadLetterStatus.REQUEUED) return { ok: true, alreadyRequeued: true, sourceId: deadLetter.requeuedSourceId ?? deadLetter.sourceId };
    if (deadLetter.status === DeadLetterStatus.RESOLVED) throw Object.assign(new Error('DEAD_LETTER_ALREADY_RESOLVED'), { statusCode: 409 });

    if (deadLetter.status === DeadLetterStatus.OPEN) {
      const prepared = await prisma.$transaction(async tx => {
        const claimed = await tx.deadLetterJob.updateMany({ where: { id, status: DeadLetterStatus.OPEN }, data: { status: DeadLetterStatus.REQUEUEING, reviewedById: user.id, reviewedAt: new Date() } });
        if (claimed.count === 0) return false;
        if (deadLetter.queue === DeadLetterQueue.SETUP) {
          const source = await tx.setupJob.findUnique({ where: { id: deadLetter.sourceId } });
          if (!source || source.status !== 'FAILED') throw Object.assign(new Error('DEAD_LETTER_SOURCE_NOT_RETRYABLE'), { statusCode: 409 });
          const next = await tx.setupJob.create({ data: { workspaceId: source.workspaceId, userId: user.id, organizationId: source.organizationId, options: source.options ?? undefined, maxDurationSeconds: source.maxDurationSeconds, attempt: source.attempt + 1, parentJobId: source.id } });
          await tx.setupJobLog.create({ data: { setupJobId: next.id, stage: SetupStage.QUEUED, message: `Reprocessamento manual criado a partir da dead-letter ${id}` } });
          await tx.deadLetterJob.update({ where: { id }, data: { requeuedSourceId: next.id } });
        } else {
          const source = await tx.orchestration.findUnique({ where: { id: deadLetter.sourceId }, select: { status: true } });
          if (!source || !['QUEUED', 'RUNNING'].includes(source.status)) throw Object.assign(new Error('DEAD_LETTER_SOURCE_NOT_RETRYABLE'), { statusCode: 409 });
          await tx.deadLetterJob.update({ where: { id }, data: { requeuedSourceId: deadLetter.sourceId } });
        }
        return true;
      });
      deadLetter = prepared
        ? await prisma.deadLetterJob.findUniqueOrThrow({ where: { id } })
        : (await loadDeadLetter(request, id)).deadLetter;
    }

    if (deadLetter.status === DeadLetterStatus.REQUEUED) {
      return { ok: true, alreadyRequeued: true, sourceId: deadLetter.requeuedSourceId ?? deadLetter.sourceId };
    }

    if (deadLetter.status !== DeadLetterStatus.REQUEUEING || !deadLetter.requeuedSourceId) {
      throw Object.assign(new Error('DEAD_LETTER_REQUEUE_IN_PROGRESS'), { statusCode: 409 });
    }
    if (deadLetter.queue === DeadLetterQueue.SETUP) await setupQueue.enqueue(deadLetter.requeuedSourceId);
    else await orchestrationQueue.tick(deadLetter.requeuedSourceId);

    const finalized = await prisma.deadLetterJob.updateMany({ where: { id, status: DeadLetterStatus.REQUEUEING }, data: { status: DeadLetterStatus.REQUEUED } });
    if (finalized.count > 0) {
      await audit({ userId: user.id, organizationId: deadLetter.organizationId, action: 'DEAD_LETTER_REQUEUED', resource: 'DeadLetterJob', resourceId: id, ipAddress: request.ip, metadata: { queue: deadLetter.queue, sourceId: deadLetter.sourceId, requeuedSourceId: deadLetter.requeuedSourceId } });
    }
    return { ok: true, alreadyRequeued: finalized.count === 0, sourceId: deadLetter.requeuedSourceId };
  });
}
