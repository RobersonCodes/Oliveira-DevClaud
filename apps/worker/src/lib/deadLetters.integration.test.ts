import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeadLetterQueue, prisma } from '@oliveira/database';
import { recordPermanentJobFailure } from './deadLetters.js';

const createdOrganizationIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  while (createdOrganizationIds.length) {
    await prisma.organization.delete({ where: { id: createdOrganizationIds.pop()! } }).catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('dead-letter persistence — real PostgreSQL', () => {
  it('stores one sanitized record when the same permanent failure is captured again', async () => {
    const suffix = crypto.randomUUID();
    const organization = await prisma.organization.create({
      data: { name: 'Dead-letter test', slug: `dead-letter-${suffix}` }
    });
    createdOrganizationIds.push(organization.id);
    const sourceJobId = `bull-${suffix}`;

    await recordPermanentJobFailure({
      database: prisma,
      queue: DeadLetterQueue.ORCHESTRATION,
      organizationId: organization.id,
      sourceId: `orchestration-${suffix}`,
      sourceJobId,
      payload: { orchestrationId: `orchestration-${suffix}` },
      attempts: 1,
      error: new Error('token=super-secret')
    });
    await recordPermanentJobFailure({
      database: prisma,
      queue: DeadLetterQueue.ORCHESTRATION,
      organizationId: organization.id,
      sourceId: `orchestration-${suffix}`,
      sourceJobId,
      payload: { orchestrationId: `orchestration-${suffix}` },
      attempts: 5,
      error: new Error('token=changed-secret')
    });

    const records = await prisma.deadLetterJob.findMany({ where: { organizationId: organization.id } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      queue: DeadLetterQueue.ORCHESTRATION,
      sourceJobId,
      payload: { orchestrationId: `orchestration-${suffix}` },
      errorCode: 'PERMANENT_JOB_FAILURE',
      attempts: 5,
      status: 'OPEN'
    });
    expect(JSON.stringify(records[0])).not.toContain('super-secret');
    expect(JSON.stringify(records[0])).not.toContain('changed-secret');
  });
});
