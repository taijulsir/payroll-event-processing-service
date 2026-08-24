import { Provider } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import {
  PAYROLL_EVENTS_JOB_ATTEMPTS,
  PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS,
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  REDIS_CONNECTION,
} from './processing.constants';

/**
 * The queue itself. `defaultJobOptions`:
 *
 * - `attempts`/`backoff` (retry/backoff design, R2 — architecture.md §13's "BullMQ's built-in
 *   `attempts` + exponential `backoff`"): BullMQ's own delivery-retry budget and backoff
 *   curve, applied to every job added via `PayrollEventsQueueService.enqueue()` since it adds
 *   no per-call overrides. See processing.constants.ts for exactly what these two constants
 *   mean and how they relate to (but are not the same as) `payroll_events.attempts`.
 * - A bounded `removeOnComplete`/`removeOnFail` count IS set: with no retention policy at
 *   all, BullMQ keeps every completed/failed job in Redis forever, which is unbounded
 *   growth for a system that's expected to run for more than a few minutes. This is a
 *   housekeeping default, not a retry/processing policy — nothing here processes a job
 *   differently based on it.
 */
export const payrollEventsQueueProvider: Provider = {
  provide: PAYROLL_EVENTS_QUEUE,
  inject: [REDIS_CONNECTION],
  useFactory: (connection: Redis): Queue =>
    new Queue(PAYROLL_EVENTS_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: PAYROLL_EVENTS_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
};
