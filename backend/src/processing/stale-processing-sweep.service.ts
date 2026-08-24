import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventProcessingService } from './event-processing.service';
import { PayrollEventsQueueService } from './payroll-events-queue.service';
import {
  STALE_PROCESSING_SWEEP_INTERVAL_MS,
  STALE_PROCESSING_TIMEOUT_MS,
} from './processing.constants';

/**
 * Retry/backoff design, R4 — the approved mechanism for closing the crash-recovery gap
 * architecture.md §14 names but does not itself specify a concrete mechanism for ("Crash
 * during processing... the redelivered attempt re-runs from PROCESSING, calling the provider
 * again" describes the desired OUTCOME; this sweep is the concrete design chosen to achieve
 * it safely — see the R4 design-decision record for why relying on BullMQ's own stalled-job
 * reclamation alone was rejected: application code cannot distinguish "this delivery is a
 * real stall reclaim" from "this is an ordinary duplicate delivery," so removing the existing
 * already-processing guard unconditionally would have broken R2/R3's already-tested
 * duplicate-processing-safety guarantee).
 *
 * Structurally parallel to, but a DIFFERENT mechanism from, architecture.md §15's own
 * reconciliation sweep for the submit-then-enqueue gap: like that sweep, this one is
 * Postgres-only and best-effort — it never inspects Redis/BullMQ state, and is safe to run
 * repeatedly, because every write it performs goes through the exact same CAS guard
 * (`EventProcessingService.recoverStaleProcessing`) that already makes redelivery/duplicate
 * processing safe everywhere else in this codebase. Unlike §15's sweep, this one queries
 * `status='PROCESSING' AND processing_started_at < threshold` (not PENDING/submittedAt) and
 * transitions PROCESSING -> PENDING — an already-approved transition (database-design.md
 * §11), reused from R2, not a new status.
 *
 * Runs once on module init and then on a fixed interval — architecture.md §15's own words for
 * its sweep ("run on worker startup and on a fixed interval"), applied here since no periodic-
 * scheduling infrastructure previously existed in this codebase. A plain `setInterval` is the
 * smallest mechanism the existing NestJS/worker architecture already supports (approved: no
 * new dependency such as `@nestjs/schedule`).
 *
 * Worker-only, like WorkerProcessingModule's other pieces: registered only there, never
 * imported by AppModule, so the API process never runs this sweep.
 */
@Injectable()
export class StaleProcessingSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleProcessingSweepService.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventProcessingService: EventProcessingService,
    private readonly queue: PayrollEventsQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runSweep(); // "on worker startup"

    this.intervalHandle = setInterval(() => {
      this.runSweep().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`stale-processing sweep tick failed unexpectedly: ${message}`);
      });
    }, STALE_PROCESSING_SWEEP_INTERVAL_MS);
    // Never let this timer alone keep the process alive — matches the rest of this module's
    // graceful-shutdown posture (architecture.md §5's "graceful shutdown" note).
    this.intervalHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  /**
   * One sweep pass: find candidate stale PROCESSING events (a single Postgres query, no
   * Redis/BullMQ inspection), attempt recovery for each independently (one candidate's
   * failure or lost race must never abort the rest), and re-enqueue only the ones that were
   * actually returned to PENDING — an event finalized as exhausted, or already moved on by
   * the time recovery ran, has nothing new to process.
   */
  async runSweep(): Promise<void> {
    const threshold = new Date(Date.now() - STALE_PROCESSING_TIMEOUT_MS);

    const candidates = await this.prisma.payrollEvent.findMany({
      where: { status: 'PROCESSING', processingStartedAt: { lt: threshold } },
      select: { id: true },
    });

    if (candidates.length === 0) {
      this.logger.log('stale-processing sweep: no candidates found');
      return;
    }

    this.logger.warn(`stale-processing sweep: found ${candidates.length} candidate(s)`);

    for (const { id: eventId } of candidates) {
      try {
        const result = await this.eventProcessingService.recoverStaleProcessing(eventId);

        if (result.outcome === 'retry-scheduled') {
          // jobId = eventId (architecture.md §9's existing defense-in-depth): if a job for
          // this event is somehow still present in Redis, BullMQ's own dedup makes this a
          // harmless no-op; if not, this is exactly what makes the recovered event
          // processable again. Job payload stays the minimal { eventId } — never status,
          // attempts, or anything else recovery just observed.
          await this.queue.enqueue(eventId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `stale-processing sweep: failed to recover eventId=${eventId}: ${message}`,
        );
        // Deliberately not rethrown: one candidate's failure must not abort the rest of the
        // sweep, and must never crash the worker process (same error-isolation posture as
        // the main processor and the R3 backstop).
      }
    }
  }
}
