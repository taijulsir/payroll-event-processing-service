import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import {
  PAYROLL_EVENTS_QUEUE,
  PROCESS_PAYROLL_EVENT_JOB_NAME,
  REDIS_CONNECTION,
} from './processing.constants';

/**
 * The only way the rest of the application talks to the queue — a narrow `enqueue(eventId)`
 * surface, not the raw BullMQ `Queue` API, so callers can't accidentally reach for something
 * broader than this phase approves (e.g. a second queue, a different job shape).
 *
 * Job payload is intentionally just `{ eventId }` (architecture.md §9 / this phase's
 * instructions): the (future) worker always re-reads authoritative state from Postgres by
 * this id rather than trusting anything carried in the job — Postgres remains the single
 * source of truth, the job is only ever "there is work for this event id."
 *
 * `jobId: eventId` (never a random id, never the idempotencyKey) is what makes a redundant
 * `enqueue()` call for the same event safe: BullMQ treats a second `add()` with an
 * already-existing jobId as a no-op rather than creating a second job. This is the queue-
 * level defense-in-depth layer under the database's own idempotency guarantee
 * (database-design.md §7/§10) — the two are independent mechanisms for two different
 * problems (duplicate HTTP submission vs. duplicate queue entries for one event) and neither
 * replaces the other.
 */
@Injectable()
export class PayrollEventsQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PayrollEventsQueueService.name);

  constructor(
    @Inject(PAYROLL_EVENTS_QUEUE) private readonly queue: Queue,
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
  ) {}

  async enqueue(eventId: string): Promise<void> {
    await this.queue.add(PROCESS_PAYROLL_EVENT_JOB_NAME, { eventId }, { jobId: eventId });
    this.logger.log(`enqueued job: eventId=${eventId} jobId=${eventId}`);
  }

  /**
   * BullMQ's `Queue.close()` only tears down connections it created itself — since this
   * queue was given an already-constructed shared connection (so HealthModule can reuse the
   * same one for its ping), that connection is this service's responsibility to close too,
   * or the process is left with an open Redis socket after shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
