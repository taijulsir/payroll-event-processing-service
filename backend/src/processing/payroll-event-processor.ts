import { Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { EventProcessingService } from './event-processing.service';
import { ORDERING_DEFER_DELAY_MS } from './processing.constants';

/**
 * The BullMQ-facing adapter: translates a raw `Job` into a call to `EventProcessingService`.
 * Kept separate from that service so the "talks to BullMQ" concern and the "talks to
 * Postgres" concern don't mix in one class — mirrors controller/service separation
 * elsewhere in this codebase (task instructions: "BullMQ job -> processor -> event
 * processing service -> Prisma").
 *
 * Per-job error isolation lives here: a thrown error from this function only fails the
 * individual BullMQ job (BullMQ's Worker catches it internally and emits 'failed' — it does
 * not crash the worker process or stop subsequent jobs from being picked up), so the worker
 * process itself is never at risk from one bad job.
 */
export function createPayrollEventProcessor(eventProcessingService: EventProcessingService) {
  const logger = new Logger('PayrollEventProcessor');

  // `token` is BullMQ's second argument to a Processor function (verified against the
  // installed 6.2.0 API: `Processor = (job, token?, signal?) => Promise<R>`) — the lock
  // token for this job, required by `job.moveToDelayed(timestamp, token)` below.
  return async function processPayrollEventJob(
    job: Job<{ eventId?: unknown }>,
    token?: string,
  ): Promise<void> {
    logger.log(`job received: jobId=${job.id}`);

    const eventId = job.data?.eventId;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      // A malformed job cannot even be attributed to an event — this is a genuine failure of
      // the job itself (not one of EventProcessingService's known safe no-op outcomes), so it
      // is reported as such: BullMQ marks the job failed, and moves on to the next one.
      logger.error(
        `malformed job data: jobId=${job.id} data=${JSON.stringify(job.data)} — missing eventId`,
      );
      throw new Error(`malformed job ${job.id}: missing or invalid eventId`);
    }

    let result;
    try {
      result = await eventProcessingService.processEvent(eventId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `unexpected error processing job: jobId=${job.id} eventId=${eventId}: ${message}`,
      );
      throw err; // let BullMQ mark this job failed; the worker process itself is unaffected.
    }

    // Retry/backoff design, R2: EventProcessingService has already committed the
    // PROCESSING -> PENDING retry transition (its own, separate transaction) by this point —
    // throwing here does not risk any inconsistent database state, it only tells BullMQ "this
    // delivery didn't finish, please redeliver." Retry scheduling itself (the backoff delay,
    // the redelivery, the delivery-count budget) is entirely BullMQ's own job, configured via
    // the queue's defaultJobOptions (payroll-events-queue.provider.ts) — this is the one place
    // that translates our outcome model into BullMQ's own throw-to-retry mechanism.
    if (result.outcome === 'retry-scheduled') {
      logger.warn(`job will be retried by BullMQ: jobId=${job.id} eventId=${eventId}`);
      throw new Error(`event ${eventId} scheduled for retry (transient provider failure)`);
    }

    // Per-employee ordering (architecture.md §12): the event was NOT claimed — an earlier,
    // non-terminal sibling exists for this employee. This is a scheduling wait, not a
    // processing failure: `job.moveToDelayed()` + throwing `DelayedError` (verified against
    // the installed BullMQ 6.2.0 source — worker.js's handleFailed special-cases
    // `err instanceof DelayedError`/`err.name === 'DelayedError'` and returns via
    // `moveToActive()` WITHOUT ever calling `job.moveToFailed()`, the only place
    // `attemptsMade` is incremented, and WITHOUT emitting `'failed'`) is BullMQ's own
    // documented mechanism for a processor to voluntarily postpone a job without consuming
    // any attempt budget or triggering the R3 backstop. `DelayedError` must never be caught
    // and converted into a normal success/failure here or anywhere else — it must propagate
    // exactly as thrown.
    if (result.outcome === 'ordering-blocked') {
      logger.log(`job deferred (per-employee ordering): jobId=${job.id} eventId=${eventId}`);
      await job.moveToDelayed(Date.now() + ORDERING_DEFER_DELAY_MS, token);
      throw new DelayedError();
    }
  };
}
