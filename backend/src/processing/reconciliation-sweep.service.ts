import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollEventsQueueService } from './payroll-events-queue.service';
import {
  RECONCILIATION_AGE_THRESHOLD_MS,
  RECONCILIATION_SWEEP_INTERVAL_MS,
} from './processing.constants';

/**
 * Reconciliation design — the approved mechanism for closing the DB-commit → queue-enqueue
 * gap architecture.md §15 describes: the submission transaction (Postgres) and the enqueue
 * call (Redis) are two separate systems with no shared transaction, so there is an
 * unavoidable, narrow window where the DB commit succeeds but the enqueue call never happens
 * (process crash between the two, or a Redis blip) — leaving a `PENDING` row with no
 * corresponding BullMQ job, which would otherwise never be processed.
 *
 * Structurally parallel to, but a DIFFERENT mechanism from, retry/backoff design R4's
 * `StaleProcessingSweepService`: that sweep recovers `PROCESSING` events whose *worker*
 * appears to have crashed (`processing_started_at` stale) and transitions them back to
 * `PENDING`. This sweep never transitions anything — it only finds `PENDING` events whose
 * `submitted_at` is old enough to suspect the original enqueue never happened, and attempts a
 * best-effort re-enqueue. The two sweeps query different columns, target different statuses,
 * and solve unrelated problems; neither replaces the other (both are registered in
 * `WorkerProcessingModule`, side by side).
 *
 * Deliberately does NOT inspect Redis/BullMQ state to decide whether a job "already exists"
 * for a candidate — per architecture.md §15, that question doesn't need answering up front:
 *   - If an active/waiting/delayed job with `jobId = eventId` is still present, BullMQ's own
 *     job-id deduplication (already established, §9) rejects the redundant `add()` — this
 *     sweep simply treats that the same as any other successful `enqueue()` call (it's a
 *     fire-and-forget `queue.add()`; a duplicate jobId is not an error from this sweep's
 *     point of view).
 *   - If the event has already reached a terminal status, or is already `PROCESSING`, it
 *     isn't a candidate at all — the query itself excludes it.
 * Correctness does not depend on this sweep guessing right — it depends on the worker/database
 * idempotency guards already established (`EventProcessingService`'s terminal-status no-op
 * check and claim CAS), which make re-enqueuing an event that's already queued or already
 * finished harmless regardless of what this sweep does. This sweep only needs to be
 * *effective* (an orphaned event eventually gets another attempt), not *precise*
 * (architecture.md §15, verbatim).
 *
 * Never transitions `payroll_events.status` itself, and never invokes the payroll provider —
 * it only reads candidates and calls `PayrollEventsQueueService.enqueue()`, reusing the exact
 * same jobId-is-eventId, `{ eventId }`-payload mechanism every other enqueue path in this
 * codebase uses. The worker remains solely responsible for claiming (`PENDING -> PROCESSING`)
 * and processing a reconciled event, exactly like any other job.
 *
 * Runs once on module init and then on a fixed interval — architecture.md §15's own words
 * ("run on worker startup and on a fixed interval"), the same lifecycle/cleanup pattern
 * `StaleProcessingSweepService` (R4) already established: a plain `setInterval`, unref'd so it
 * never keeps the process alive on its own, cleared in `onModuleDestroy`. No new scheduling
 * dependency (e.g. `@nestjs/schedule`) is introduced.
 *
 * Worker-only, like `StaleProcessingSweepService`: registered only in `WorkerProcessingModule`,
 * never imported by `AppModule`, so the API process never runs this sweep.
 */
@Injectable()
export class ReconciliationSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationSweepService.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PayrollEventsQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runSweep(); // "on worker startup"

    this.intervalHandle = setInterval(() => {
      this.runSweep().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`reconciliation sweep tick failed unexpectedly: ${message}`);
      });
    }, RECONCILIATION_SWEEP_INTERVAL_MS);
    // Never let this timer alone keep the process alive — matches
    // StaleProcessingSweepService's (R4) graceful-shutdown posture.
    this.intervalHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  /**
   * One sweep pass: find candidate orphaned `PENDING` events (a single Postgres query — no
   * Redis/BullMQ inspection, no `LIMIT`, per the approved design), then attempt a best-effort
   * re-enqueue for each independently. A candidate's enqueue failure is caught, logged, and
   * never aborts the rest of the sweep or crashes the worker — the event is left exactly as
   * it was (`PENDING`, no business-state mutation of any kind), so the next sweep tick can
   * retry it.
   *
   * The query is exactly database-design.md §18's own worked example for this case:
   * `WHERE status = 'PENDING' AND submitted_at < :threshold`, served entirely by the existing
   * `(status, submitted_at)` composite index (database-design.md §8/§14) — no new index.
   */
  async runSweep(): Promise<void> {
    const threshold = new Date(Date.now() - RECONCILIATION_AGE_THRESHOLD_MS);

    const candidates = await this.prisma.payrollEvent.findMany({
      where: { status: 'PENDING', submittedAt: { lt: threshold } },
      select: { id: true },
    });

    if (candidates.length === 0) {
      this.logger.log('reconciliation sweep: no candidates found');
      return;
    }

    this.logger.warn(`reconciliation sweep: found ${candidates.length} candidate(s)`);

    for (const { id: eventId } of candidates) {
      try {
        // jobId = eventId (architecture.md §9's existing defense-in-depth): if a job for this
        // event is somehow still present in Redis, BullMQ's own dedup makes this a harmless
        // no-op; if not, this is exactly what makes the orphaned event processable. Job
        // payload stays the minimal { eventId } — this sweep never reads or carries anything
        // else about the event.
        await this.queue.enqueue(eventId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`reconciliation sweep: failed to enqueue eventId=${eventId}: ${message}`);
        // Deliberately not rethrown: one candidate's failure must not abort the rest of the
        // sweep, and must never crash the worker process (same error-isolation posture as
        // StaleProcessingSweepService, the main processor, and the R3 backstop). The event
        // stays PENDING and remains eligible for the next sweep tick.
      }
    }
  }
}
