import type { Job, Metrics, Queue } from 'bullmq';
import { OrchestrationQueue } from '@oliveira/orchestrator-engine';
import { SetupQueue } from '@oliveira/setup-queue';

const JOB_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'completed', 'failed'] as const;
const SAMPLE_SIZE = 100;
const HOUR_DATA_POINTS = 60;

type QueueLike = Pick<Queue, 'getJobCounts' | 'getJobs' | 'getMetrics'>;
type FinishedJob = Pick<Job, 'timestamp' | 'processedOn' | 'finishedOn' | 'attemptsMade'>;

function distribution(values: number[]) {
  if (!values.length) return { samples: 0, average: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    samples: sorted.length,
    average: Math.round(sum / sorted.length),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted[sorted.length - 1]!
  };
}

const recentCount = (metrics: Metrics) => metrics.data.slice(0, HOUR_DATA_POINTS).reduce((sum, value) => sum + value, 0);

export async function collectQueueMetrics(name: string, queue: QueueLike) {
  const [counts, completedMetrics, failedMetrics, jobs] = await Promise.all([
    queue.getJobCounts(...JOB_STATES),
    queue.getMetrics('completed', 0, HOUR_DATA_POINTS - 1),
    queue.getMetrics('failed', 0, HOUR_DATA_POINTS - 1),
    queue.getJobs(['completed', 'failed'], 0, SAMPLE_SIZE - 1, false) as Promise<FinishedJob[]>
  ]);
  const queueWaitMs = jobs.flatMap(job => job.processedOn === undefined ? [] : [Math.max(0, job.processedOn - job.timestamp)]);
  const processingMs = jobs.flatMap(job => job.processedOn === undefined || job.finishedOn === undefined
    ? []
    : [Math.max(0, job.finishedOn - job.processedOn)]);
  const retriedJobs = jobs.filter(job => job.attemptsMade > 1);

  return {
    name,
    depth: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
      waitingChildren: counts['waiting-children'] ?? 0,
      failedRetained: counts.failed ?? 0
    },
    throughput: {
      completedTotal: completedMetrics.meta.count,
      failedTotal: failedMetrics.meta.count,
      completedLastHour: recentCount(completedMetrics),
      failedLastHour: recentCount(failedMetrics)
    },
    latencyMs: {
      queueWait: distribution(queueWaitMs),
      processing: distribution(processingMs)
    },
    retries: {
      sampleSize: jobs.length,
      jobsRetried: retriedJobs.length,
      retryAttempts: retriedJobs.reduce((sum, job) => sum + Math.max(0, job.attemptsMade - 1), 0)
    }
  };
}

export type QueueMetrics = Awaited<ReturnType<typeof collectQueueMetrics>>;

export interface QueueMetricsCollector {
  collect(): Promise<{ status: 'ok'; queues: QueueMetrics[] } | { status: 'unavailable'; queues: []; error: 'QUEUE_METRICS_UNAVAILABLE' }>;
  close(): Promise<void>;
}

export function createQueueMetricsCollector(): QueueMetricsCollector {
  const orchestrations = new OrchestrationQueue();
  const setup = new SetupQueue();
  return {
    async collect() {
      try {
        return {
          status: 'ok' as const,
          queues: await Promise.all([
            collectQueueMetrics('oliveira-orchestrations', orchestrations.queue),
            collectQueueMetrics('oliveira-setup', setup.queue)
          ])
        };
      } catch {
        // Host metrics remain usable during Redis incidents and never leak connection details.
        return { status: 'unavailable' as const, queues: [], error: 'QUEUE_METRICS_UNAVAILABLE' as const };
      }
    },
    async close() {
      await Promise.allSettled([orchestrations.queue.close(), setup.close()]);
    }
  };
}
