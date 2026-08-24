import { Logger, Provider } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { createPayrollEventProcessor } from './payroll-event-processor';
import { EventProcessingService } from './event-processing.service';
import {
  PAYROLL_EVENTS_QUEUE_NAME,
  PAYROLL_EVENTS_WORKER,
  REDIS_CONNECTION,
} from './processing.constants';

/**
 * The BullMQ Worker that actually consumes `payroll-events` jobs. Reuses the existing
 * REDIS_CONNECTION token and PAYROLL_EVENTS_QUEUE_NAME constant (this queue is not
 * duplicated — the Worker and the producer Queue point at the same Redis queue by name).
 *
 * `concurrency: 5` matches architecture.md §9's already-approved worker concurrency figure
 * — not something invented for this phase. Per-employee ordering (a later phase) is what
 * gives this number teeth; nothing in this phase depends on it being any particular value,
 * since each event's CAS is independently scoped by its own id regardless of how many jobs
 * run in parallel.
 */
export const payrollEventsWorkerProvider: Provider = {
  provide: PAYROLL_EVENTS_WORKER,
  inject: [REDIS_CONNECTION, EventProcessingService],
  useFactory: (connection: Redis, eventProcessingService: EventProcessingService): Worker => {
    const logger = new Logger('PayrollEventsWorker');

    const worker = new Worker(
      PAYROLL_EVENTS_QUEUE_NAME,
      createPayrollEventProcessor(eventProcessingService),
      { connection, concurrency: 5 },
    );

    worker.on('error', (err) => logger.error(`worker error: ${err.message}`));
    worker.on('failed', (job, err) => {
      logger.error(`job failed: jobId=${job?.id} eventId=${job?.data?.eventId}: ${err.message}`);
    });
    worker.on('completed', (job) => {
      logger.log(`job completed: jobId=${job.id} eventId=${job.data?.eventId}`);
    });

    return worker;
  },
};
