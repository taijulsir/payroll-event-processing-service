import { Provider } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  REDIS_CONNECTION,
} from './processing.constants';

/**
 * The queue itself. Deliberately minimal `defaultJobOptions`:
 *
 * - No `attempts`/`backoff` here — retry/backoff is business logic that belongs to the
 *   worker phase (architecture.md §13), not a queue-level default to guess at now.
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
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
};
