import { describe, expect, it, vi } from 'vitest';
import { collectQueueMetrics } from './queueMetrics.js';

const metrics = (count: number, data: number[]) => ({ meta: { count, prevTS: 0, prevCount: 0 }, data, count: data.length });

describe('BullMQ queue metrics', () => {
  it('reports depth, native throughput, latency percentiles and retries from a bounded sample', async () => {
    const queue = {
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 3, active: 1, delayed: 2, prioritized: 1, 'waiting-children': 4, completed: 10, failed: 2 }),
      getMetrics: vi.fn().mockImplementation((type: string) => type === 'completed'
        ? metrics(120, [7, 5])
        : metrics(9, [2, 1])),
      getJobs: vi.fn().mockResolvedValue([
        { timestamp: 1_000, processedOn: 1_100, finishedOn: 1_500, attemptsMade: 1 },
        { timestamp: 2_000, processedOn: 2_300, finishedOn: 3_300, attemptsMade: 3 }
      ])
    };

    const result = await collectQueueMetrics('queue-a', queue as never);

    expect(result.depth).toEqual({ waiting: 3, active: 1, delayed: 2, prioritized: 1, waitingChildren: 4, failedRetained: 2 });
    expect(result.throughput).toEqual({ completedTotal: 120, failedTotal: 9, completedLastHour: 12, failedLastHour: 3 });
    expect(result.latencyMs.queueWait).toEqual({ samples: 2, average: 200, p95: 300, max: 300 });
    expect(result.latencyMs.processing).toEqual({ samples: 2, average: 700, p95: 1_000, max: 1_000 });
    expect(result.retries).toEqual({ sampleSize: 2, jobsRetried: 1, retryAttempts: 2 });
  });

  it('uses null latency values and zero retry counters when no finished jobs are retained', async () => {
    const queue = {
      getJobCounts: vi.fn().mockResolvedValue({}),
      getMetrics: vi.fn().mockResolvedValue(metrics(0, [])),
      getJobs: vi.fn().mockResolvedValue([])
    };
    const result = await collectQueueMetrics('empty', queue as never);
    expect(result.latencyMs.queueWait).toEqual({ samples: 0, average: null, p95: null, max: null });
    expect(result.retries).toEqual({ sampleSize: 0, jobsRetried: 0, retryAttempts: 0 });
  });
});
