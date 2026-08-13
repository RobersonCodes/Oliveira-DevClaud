import crypto from 'node:crypto';
import { QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { ORCHESTRATION_TICK_JOB_OPTIONS, OrchestrationQueue, orchestrationTickDeduplicationId, readyStepKeys, validateDag } from './index.js';

describe('orchestration tick retry policy', () => {
  it('uses a short exponential backoff with jitter and a bounded attempt count', () => {
    expect(ORCHESTRATION_TICK_JOB_OPTIONS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 },
      removeOnComplete: true,
      removeOnFail: 500
    });
  });

  it('derives one stable idempotency key per orchestration', () => {
    expect(orchestrationTickDeduplicationId('orch-123')).toBe('tick-orch-123');
    expect(orchestrationTickDeduplicationId('orch-123')).toBe(orchestrationTickDeduplicationId('orch-123'));
    expect(orchestrationTickDeduplicationId('orch-456')).not.toBe(orchestrationTickDeduplicationId('orch-123'));
  });
});

describe('validateDag', () => {
  it('rejects an empty plan', () => {
    expect(() => validateDag([])).toThrow('PLAN_REQUIRES_STEPS');
  });

  it('rejects a cycle', () => {
    expect(() =>
      validateDag([
        { key: 'a', title: 'A', type: 'SYSTEM', command: 'npm test', dependsOn: ['b'] },
        { key: 'b', title: 'B', type: 'SYSTEM', command: 'npm test', dependsOn: ['a'] }
      ])
    ).toThrow('PLAN_HAS_CYCLE');
  });

  it('rejects a dependency on an unknown step', () => {
    expect(() => validateDag([{ key: 'a', title: 'A', type: 'SYSTEM', command: 'npm test', dependsOn: ['ghost'] }])).toThrow('UNKNOWN_DEPENDENCY:ghost');
  });

  it('accepts a valid linear DAG', () => {
    expect(
      validateDag([
        { key: 'a', title: 'A', type: 'SYSTEM', command: 'npm test' },
        { key: 'b', title: 'B', type: 'SYSTEM', command: 'npm test', dependsOn: ['a'] }
      ])
    ).toBe(true);
  });
});

describe('readyStepKeys', () => {
  it('only surfaces BLOCKED steps whose dependencies are all COMPLETED', () => {
    const steps = [
      { key: 'a', status: 'COMPLETED', dependsOn: [] },
      { key: 'b', status: 'BLOCKED', dependsOn: ['a'] },
      { key: 'c', status: 'BLOCKED', dependsOn: ['b'] }
    ];
    expect(readyStepKeys(steps)).toEqual(['b']);
  });
});

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function withIsolatedQueue<T>(run: (queue: OrchestrationQueue, queueName: string) => Promise<T>) {
  const queueName = `test-orchestrations-${crypto.randomUUID()}`;
  const queue = new OrchestrationQueue(redisUrl, queueName);
  try {
    return await run(queue, queueName);
  } finally {
    await queue.queue.obliterate({ force: true }).catch(() => undefined);
    await queue.queue.close();
  }
}

describe('OrchestrationQueue.tick — safe deduplication (isolated real Redis queue)', () => {
  it('coalesces back-to-back ticks for one orchestration', async () => {
    await withIsolatedQueue(async queue => {
      const orchestrationId = `test-orch-${crypto.randomUUID()}`;
      await Promise.all([queue.tick(orchestrationId), queue.tick(orchestrationId)]);

      const jobs = await queue.queue.getJobs(['waiting', 'active', 'delayed']);
      expect(jobs.filter(job => job.data.orchestrationId === orchestrationId)).toHaveLength(1);
    });
  });

  it('does not collide ticks belonging to different orchestrations', async () => {
    await withIsolatedQueue(async queue => {
      const a = `test-orch-${crypto.randomUUID()}`;
      const b = `test-orch-${crypto.randomUUID()}`;
      await Promise.all([queue.tick(a), queue.tick(b)]);

      const jobs = await queue.queue.getJobs(['waiting', 'active', 'delayed']);
      expect(jobs.some(job => job.data.orchestrationId === a)).toBe(true);
      expect(jobs.some(job => job.data.orchestrationId === b)).toBe(true);
    });
  });

  it('preserves exactly one trailing tick requested by the active tick', async () => {
    await withIsolatedQueue(async (queue, queueName) => {
      const orchestrationId = `test-orch-${crypto.randomUUID()}`;
      const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      let executions = 0;
      let resolveSecond!: () => void;
      const secondExecution = new Promise<void>(resolve => { resolveSecond = resolve; });
      const worker = new Worker(
        queueName,
        async job => {
          if (job.data.orchestrationId !== orchestrationId) return;
          executions += 1;
          if (executions === 1) await queue.tick(orchestrationId);
          if (executions === 2) resolveSecond();
        },
        { connection: workerConnection, concurrency: 1 }
      );

      try {
        await worker.waitUntilReady();
        await queue.tick(orchestrationId);
        await Promise.race([
          secondExecution,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TRAILING_TICK_TIMEOUT')), 5_000))
        ]);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(executions).toBe(2);
      } finally {
        await worker.close();
        if (workerConnection.status !== 'end') await workerConnection.quit().catch(() => undefined);
      }
    });
  });

  it('retries transient processor failures with the configured policy', async () => {
    await withIsolatedQueue(async (queue, queueName) => {
      const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const eventsConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const events = new QueueEvents(queueName, { connection: eventsConnection });
      let executions = 0;
      const worker = new Worker(queueName, async () => {
        executions += 1;
        if (executions < 3) throw new Error('ECONNRESET');
        return 'recovered';
      }, { connection: workerConnection, concurrency: 1 });

      try {
        await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
        const job = await queue.tick(`retry-${crypto.randomUUID()}`);
        await expect(job.waitUntilFinished(events, 10_000)).resolves.toBe('recovered');
        expect(executions).toBe(3);
        expect(job.opts.attempts).toBe(ORCHESTRATION_TICK_JOB_OPTIONS.attempts);
      } finally {
        await worker.close();
        await events.close();
        if (workerConnection.status !== 'end') await workerConnection.quit().catch(() => undefined);
        if (eventsConnection.status !== 'end') await eventsConnection.quit().catch(() => undefined);
      }
    });
  }, 15_000);

  it('does not retry an unrecoverable processor failure', async () => {
    await withIsolatedQueue(async (queue, queueName) => {
      const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const eventsConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const events = new QueueEvents(queueName, { connection: eventsConnection });
      let executions = 0;
      const worker = new Worker(queueName, async () => {
        executions += 1;
        throw new UnrecoverableError('WORKSPACE_HAS_NO_CONTAINER');
      }, { connection: workerConnection, concurrency: 1 });

      try {
        await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
        const job = await queue.tick(`permanent-${crypto.randomUUID()}`);
        await expect(job.waitUntilFinished(events, 5_000)).rejects.toThrow('WORKSPACE_HAS_NO_CONTAINER');
        expect(executions).toBe(1);
      } finally {
        await worker.close();
        await events.close();
        if (workerConnection.status !== 'end') await workerConnection.quit().catch(() => undefined);
        if (eventsConnection.status !== 'end') await eventsConnection.quit().catch(() => undefined);
      }
    });
  }, 10_000);
});
