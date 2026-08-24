import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EventProcessingService } from './event-processing.service';

/**
 * The BullMQ-facing adapter for the retry/backoff design's R3 backstop: translates a raw
 * `Worker` `'failed'` event into a call to `EventProcessingService.reconcileExhaustedJob`.
 * Kept separate from both the Worker wiring (payroll-events-worker.provider.ts) and the main
 * job processor (payroll-event-processor.ts), mirroring the existing "BullMQ-facing adapter
 * vs Postgres-facing service" separation already established in this module.
 *
 * This is a SECONDARY safety net, not the primary exhaustion mechanism — R2's own
 * attempts-vs-maxAttempts check inside `EventProcessingService` already finalizes the normal
 * case, before the processor ever throws, so BullMQ's `'failed'` event does not even fire for
 * a normal R2 exhaustion. This handler only matters for the residual gap where BullMQ itself
 * considers a job exhausted but the normal path never persisted a terminal state.
 *
 * Per-listener error isolation lives here, the same way it does in the main processor: this
 * function must never let an unexpected error propagate out of a `'failed'` event handler —
 * an uncaught exception thrown from an EventEmitter listener is a process-level unhandled
 * error, not something BullMQ can catch or attribute to a job the way it does for the
 * processor function, so this handler catches and logs everything itself.
 */
export function createFailedJobBackstopHandler(eventProcessingService: EventProcessingService) {
  const logger = new Logger('PayrollEventFailedBackstop');

  return async function handleFailedJob(
    job: Job<{ eventId?: unknown }> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) {
      // BullMQ's own documented case: "job parameter could be received as undefined when a
      // stalled job reaches the stalled limit and it is deleted by the removeOnFail option."
      // No eventId is available at all — this backstop has nothing to act on. Stalled-job
      // recovery is explicitly R4's scope, not this one's.
      logger.error(`failed event received with no job (stalled/removed): ${err.message}`);
      return;
    }

    const eventId = job.data?.eventId;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      logger.error(
        `failed event for a malformed job, no eventId to reconcile: jobId=${job.id} data=${JSON.stringify(job.data)}`,
      );
      return;
    }

    // Exhaustion detection, verified against the installed BullMQ 6.2.0 source
    // (classes/job.js `moveToFailed`/`shouldRetryJob`, classes/worker.js's emission order):
    // `job.attemptsMade` is incremented to include the attempt that just failed BEFORE the
    // 'failed' event is emitted, and `shouldRetryJob` schedules another delivery exactly when
    // `attemptsMade < opts.attempts`. So `attemptsMade >= opts.attempts` here means BullMQ has
    // already decided NOT to redeliver this job — a candidate for backstop reconciliation.
    // `opts.attempts` is never undefined in practice: `payrollEventsQueueProvider`'s
    // `defaultJobOptions.attempts` is merged into every job's own `opts` at creation time
    // (Queue.add()), but a `?? 1` fallback is kept here defensively in case some future job
    // is ever added with `attempts` explicitly omitted from both the per-call and default
    // options — BullMQ's own default for a job with no attempts configured at all is 1.
    const attemptsMade = job.attemptsMade;
    const configuredAttempts = job.opts.attempts ?? 1;
    const exhausted = attemptsMade >= configuredAttempts;

    if (!exhausted) {
      // Retries remain — BullMQ itself will redeliver this job per its own configured
      // backoff. Nothing for this backstop to do beyond this observability log line.
      logger.log(
        `job failed, retries remain — no reconciliation needed: jobId=${job.id} eventId=${eventId} attemptsMade=${attemptsMade}/${configuredAttempts}`,
      );
      return;
    }

    logger.warn(
      `job exhausted at the queue layer, checking Postgres for reconciliation: jobId=${job.id} eventId=${eventId} attemptsMade=${attemptsMade}/${configuredAttempts}`,
    );

    try {
      const reconciled = await eventProcessingService.reconcileExhaustedJob(eventId);
      if (reconciled) {
        logger.warn(
          `backstop finalized the event as FAILED/RETRYABLE: jobId=${job.id} eventId=${eventId}`,
        );
      } else {
        logger.log(
          `backstop found nothing to reconcile (already terminal, still PENDING, or lost a race): jobId=${job.id} eventId=${eventId}`,
        );
      }
    } catch (reconcileErr) {
      const message = reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr);
      logger.error(
        `unexpected error during backstop reconciliation: jobId=${job.id} eventId=${eventId}: ${message}`,
      );
      // Deliberately not rethrown: this is an event listener, not a job processor — BullMQ
      // does not attribute a thrown error here to any job, and letting it escape would risk
      // an unhandled exception crashing the worker process. Catch-and-log keeps the worker
      // alive, matching the error-isolation posture already established for the main
      // processor (payroll-event-processor.ts).
    }
  };
}
