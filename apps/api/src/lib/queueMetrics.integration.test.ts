import crypto from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_METRICS_OPTIONS } from '@oliveira/orchestrator-engine';
import { collectQueueMetrics } from './queueMetrics.js';

const queueName = `odc-queue-metrics-${crypto.randomUUID()}`;
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const queue = new Queue(queueName, { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) });
const events = new QueueEvents(queueName, { connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) });
let worker: Worker;
const attempts = new Map<string, number>();

beforeAll(async () => {
  await events.waitUntilReady();
  worker = new Worker(queueName, async job => {
    const attempt = (attempts.get(job.name) ?? 0) + 1;
    attempts.set(job.name, attempt);
    if (job.name === 'retry-once' && attempt === 1) throw new Error('TRANSIENT');
    if (job.name === 'always-fail') throw new Error('PERMANENT');
    return 'ok';
  }, {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
    metrics: QUEUE_METRICS_OPTIONS
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker?.close();
  await events.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
});

describe('BullMQ queue metrics — real Redis', () => {
  it('observes a retried completion and a retained permanent failure', async () => {
    const retried = await queue.add('retry-once', {}, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10 },
      removeOnComplete: 10,
      removeOnFail: 10
    });
    await expect(retried.waitUntilFinished(events, 10_000)).resolves.toBe('ok');

    const failed = await queue.add('always-fail', {}, { attempts: 1, removeOnFail: 10 });
    await expect(failed.waitUntilFinished(events, 10_000)).rejects.toThrow('PERMANENT');

    const result = await collectQueueMetrics(queueName, queue);
    expect(result.throughput.completedTotal).toBeGreaterThanOrEqual(1);
    expect(result.throughput.failedTotal).toBeGreaterThanOrEqual(1);
    expect(result.depth.failedRetained).toBe(1);
    expect(result.latencyMs.queueWait.samples).toBeGreaterThanOrEqual(2);
    expect(result.latencyMs.processing.samples).toBeGreaterThanOrEqual(2);
    expect(result.retries.jobsRetried).toBe(1);
    expect(result.retries.retryAttempts).toBe(1);
  });
});
