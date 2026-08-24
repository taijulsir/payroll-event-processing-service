import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type PayrollEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PAYROLL_PROVIDER, type PayrollProvider } from './payroll-provider';

/**
 * What actually happened when a job's event was looked at. Every branch is a legitimate,
 * expected outcome — not one of them represents an error. `processEvent()` never throws for
 * any of these; only a genuinely unexpected failure (e.g. a database error, or an unexpected
 * provider exception) propagates as a real exception, left to the caller (the BullMQ
 * processor) to log and let BullMQ mark the job failed.
 */
export type ProcessEventOutcome =
  | 'succeeded' // PROCESSING -> SUCCEEDED, this run performed the full claim-provider-finalize cycle
  | 'failed' // PROCESSING -> FAILED (PERMANENT, or RETRYABLE with budget exhausted) — terminal
  | 'retry-scheduled' // PROCESSING -> PENDING (transient failure, budget remains) — not terminal
  | 'terminal' // event was already SUCCEEDED or FAILED — safe no-op
  | 'already-processing' // event was already PROCESSING — safe no-op
  | 'lost-race' // a CAS this call attempted matched zero rows — another writer won first
  | 'missing'; // no event exists for this id

export interface ProcessEventResult {
  outcome: ProcessEventOutcome;
  event?: PayrollEvent;
}

/** Internal-only: the outcome of the PENDING -> PROCESSING claim step. */
type ClaimResult = { outcome: 'claimed'; event: PayrollEvent } | { outcome: 'lost-race' };

/**
 * The worker-side event lifecycle logic (architecture.md §8/§11/§13/§16/§17,
 * database-design.md §11/§12/§13/§18). Implements the full retry-aware lifecycle (retry/backoff
 * design, R2):
 *
 *   PENDING -> PROCESSING -> SUCCEEDED                (provider succeeds)
 *                         -> FAILED (PERMANENT)        (provider fails, non-retryable)
 *                         -> PENDING                   (provider fails, retryable, budget remains)
 *                         -> FAILED (RETRYABLE)         (provider fails, retryable, budget exhausted)
 *
 * The `PENDING` re-entry above is not a new status — `PENDING` and `PROCESSING` both already
 * existed; only the transition (and the history row recording it) is new. Retry *scheduling*
 * itself (the backoff delay, the redelivery) is entirely BullMQ's job, configured on the queue
 * (payroll-events-queue.provider.ts) — this class only ever decides "should this be retried,"
 * persists that decision, and lets the caller (payroll-event-processor.ts) translate a
 * `retry-scheduled` outcome into a thrown error so BullMQ actually redelivers the job.
 *
 * Postgres is the only source of truth here — the caller passes nothing but an `eventId`;
 * this service never trusts status/payload carried on the BullMQ job itself.
 *
 * Deliberately NOT part of EventsService: that class is the HTTP-submission surface
 * (controller -> service -> Prisma); this one is the worker-processing surface
 * (processor -> service -> Prisma -> provider). Keeping them separate matches the module
 * boundary architecture.md draws between EventsModule and ProcessingModule.
 */
@Injectable()
export class EventProcessingService {
  private readonly logger = new Logger(EventProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYROLL_PROVIDER) private readonly provider: PayrollProvider,
  ) {}

  async processEvent(eventId: string): Promise<ProcessEventResult> {
    const event = await this.prisma.payrollEvent.findUnique({ where: { id: eventId } });

    if (!event) {
      // A job referencing an event that doesn't exist in Postgres. Not this phase's job to
      // explain how that could happen (that's a reconciliation/observability concern for a
      // later phase) — only to make sure it never crashes the worker and leaves enough to
      // diagnose it.
      this.logger.warn(`event not found, treating job as a no-op: eventId=${eventId}`);
      return { outcome: 'missing' };
    }

    if (event.status === 'SUCCEEDED' || event.status === 'FAILED') {
      // Terminal-state guard (architecture.md §8, database-design.md §11): a redelivered or
      // re-enqueued job for an event that has already reached a terminal state must not call
      // the provider, must not change the event, and must not be treated as an error. This is
      // the actual safeguard against duplicate processing (this phase's §9/§10) — critical
      // once BullMQ job retention means an event's jobId may become reusable.
      this.logger.log(`terminal state, no-op: eventId=${eventId} status=${event.status}`);
      return { outcome: 'terminal', event };
    }

    if (event.status === 'PROCESSING') {
      // Already being (or already was) processed by some worker. This phase implements no
      // resumption/redo of an in-flight or crashed PROCESSING event — see the final report's
      // "crash scenario" note for exactly what this does and does not guarantee. There is
      // nothing safe to do here except observe and exit; this also structurally guarantees
      // the provider can never be invoked twice concurrently for the same event, since only
      // the single call that actually wins the CAS below ever reaches the provider.
      this.logger.log(`already PROCESSING, no-op: eventId=${eventId}`);
      return { outcome: 'already-processing', event };
    }

    // event.status === 'PENDING' here. This read is only used to decide which branch above
    // applies and to avoid attempting a pointless write when we already know the event is
    // terminal or already claimed — it is NOT the correctness mechanism. Between this read
    // and the CAS update below, any other worker could have already changed the row; that is
    // fine, because the update's own WHERE clause is what actually decides the outcome, not
    // what we observed a moment ago.
    const claim = await this.claimForProcessing(eventId);
    if (claim.outcome === 'lost-race') {
      // Another worker's CAS won the race between our read and this update. Expected under
      // concurrent processing, not an error (database-design.md §13). Because we never won
      // the claim, we never call the provider — this is the structural guarantee behind
      // "duplicate jobs cannot invoke the provider twice."
      this.logger.log(`PENDING -> PROCESSING lost race: eventId=${eventId}`);
      return { outcome: 'lost-race' };
    }

    // Transaction boundary (architecture.md §17, database-design.md §12): the claim above has
    // already committed by this point ($transaction inside claimForProcessing has returned).
    // The provider call below happens entirely outside any database transaction — no locks
    // held, no pooled connection occupied — for exactly as long as the (simulated) external
    // call takes.
    return this.runProviderAndFinalize(claim.event);
  }

  /**
   * The atomic compare-and-swap transition, exactly as documented in database-design.md §12
   * ("Processing start") and §18's query example:
   *
   *   UPDATE payroll_events
   *   SET status = 'PROCESSING', processing_started_at = now(), attempts = attempts + 1
   *   WHERE id = $1 AND status = 'PENDING'
   *
   * Expressed here via Prisma's `updateMany`, not raw SQL: `updateMany`'s `where` clause is
   * itself the atomic guard, and its returned `count` is how we detect whether *this* call
   * was the one that won — the same technique the literal `UPDATE ... RETURNING *` in the
   * docs uses, just through Prisma's query builder instead of a hand-written statement.
   *
   * The update and the append-only history insert happen inside the same transaction.
   */
  private async claimForProcessing(eventId: string): Promise<ClaimResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: { id: eventId, status: 'PENDING' },
        data: {
          status: 'PROCESSING',
          processingStartedAt: new Date(),
          attempts: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        return { outcome: 'lost-race' as const };
      }

      // Read the row back (within the same transaction, so it sees our own uncommitted
      // write) purely to get the post-increment `attempts` value for the history row — this
      // read is not part of the atomicity guarantee, the `updateMany` above already is.
      const updated = await tx.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });

      await tx.eventStatusHistory.create({
        data: {
          eventId,
          fromStatus: 'PENDING',
          toStatus: 'PROCESSING',
          attemptNumber: updated.attempts,
        },
      });

      this.logger.log(`PENDING -> PROCESSING: eventId=${eventId} attempts=${updated.attempts}`);
      return { outcome: 'claimed' as const, event: updated };
    });
  }

  /**
   * Invokes the (simulated) provider — deliberately outside any transaction — then persists
   * exactly one of the two terminal outcomes in a fresh, separate transaction. This is the
   * "between transactions" step in architecture.md §17's table.
   */
  private async runProviderAndFinalize(event: PayrollEvent): Promise<ProcessEventResult> {
    this.logger.log(`invoking provider: eventId=${event.id}`);

    const outcome = await this.provider.apply({
      eventId: event.id,
      employeeId: event.employeeId,
      eventType: event.eventType,
      payload: event.payload as Record<string, unknown>,
    });

    if (outcome.outcome === 'SUCCESS') {
      this.logger.log(`provider succeeded: eventId=${event.id}`);
      return this.finalizeSuccess(event.id, outcome.result);
    }

    // R2 (retry/backoff design): a PERMANENT failure is never retried, regardless of how much
    // attempt budget remains — retrying something known to be futile is pure waste. Same
    // catch-and-finish shape as before R1 added `classification` at all.
    if (outcome.classification === 'PERMANENT') {
      this.logger.warn(
        `provider failed (permanent): eventId=${event.id} reason=${outcome.failureReason}`,
      );
      return this.finalizeFailure(event.id, outcome.failureReason, 'PERMANENT');
    }

    // outcome.classification === 'TRANSIENT'. `event.attempts` here is the count AFTER this
    // claim's own increment (claimForProcessing already committed it) — i.e. this claim IS
    // attempt number `event.attempts`. Compare against `event.maxAttempts`, the per-event
    // Postgres column (database-design.md §4) — this DB comparison, not BullMQ's own
    // `job.attemptsMade`/`job.opts.attempts`, is what decides whether the business retry
    // budget is exhausted. See processing.constants.ts (PAYROLL_EVENTS_JOB_ATTEMPTS) for why
    // BullMQ's own, separately-configured delivery budget is a backstop, not the authority,
    // and for the crash scenario where the two could diverge.
    if (event.attempts < event.maxAttempts) {
      this.logger.warn(
        `provider failed (transient), retry budget remains: eventId=${event.id} attempts=${event.attempts}/${event.maxAttempts} reason=${outcome.failureReason}`,
      );
      return this.retryTransition(event.id, outcome.failureReason);
    }

    this.logger.warn(
      `provider failed (transient), retry budget exhausted: eventId=${event.id} attempts=${event.attempts}/${event.maxAttempts} reason=${outcome.failureReason}`,
    );
    return this.finalizeFailure(event.id, outcome.failureReason, 'RETRYABLE');
  }

  /**
   * CAS `PROCESSING -> SUCCEEDED` (database-design.md §12/§18's "Processing finish"), guarded
   * exactly like the claim step: only a call that finds the row still `PROCESSING` may write.
   * In this phase's design no other call can ever reach this method for the same event at the
   * same time (only the single caller that won claimForProcessing ever gets here), so the CAS
   * guard is defensive-by-design rather than something this phase's own tests can force to
   * actually lose — see the final report for why that's still the correct thing to write.
   */
  private async finalizeSuccess(
    eventId: string,
    result: Record<string, unknown>,
  ): Promise<ProcessEventResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: {
          status: 'SUCCEEDED',
          result: result as Prisma.InputJsonValue,
          processingFinishedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        this.logger.warn(`PROCESSING -> SUCCEEDED CAS matched no row: eventId=${eventId}`);
        return { outcome: 'lost-race' as const };
      }

      const updated = await tx.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });

      await tx.eventStatusHistory.create({
        data: {
          eventId,
          fromStatus: 'PROCESSING',
          toStatus: 'SUCCEEDED',
          attemptNumber: updated.attempts,
        },
      });

      this.logger.log(`PROCESSING -> SUCCEEDED: eventId=${eventId}`);
      return { outcome: 'succeeded' as const, event: updated };
    });
  }

  /**
   * CAS `PROCESSING -> PENDING` (retry/backoff design, R2): persists a retryable failure that
   * still has attempt budget remaining. Guarded exactly like every other worker-side
   * transition — only a call that finds the row still `PROCESSING` may write. Deliberately
   * does NOT touch `attempts` (that only ever increments at claim time — database-design.md
   * §4: "incremented on each PENDING -> PROCESSING claim") and does NOT set
   * `processingFinishedAt` (this is not a terminal transition). Does not invoke the provider
   * again and does not schedule anything itself — the caller (payroll-event-processor.ts)
   * is what turns a `retry-scheduled` outcome into a thrown error, which is what actually
   * causes BullMQ to redeliver this job after its configured backoff delay.
   */
  private async retryTransition(
    eventId: string,
    failureReason: string,
  ): Promise<ProcessEventResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        this.logger.warn(`PROCESSING -> PENDING (retry) CAS matched no row: eventId=${eventId}`);
        return { outcome: 'lost-race' as const };
      }

      const updated = await tx.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });

      await tx.eventStatusHistory.create({
        data: {
          eventId,
          fromStatus: 'PROCESSING',
          toStatus: 'PENDING',
          attemptNumber: updated.attempts,
          errorMessage: failureReason,
        },
      });

      this.logger.warn(
        `PROCESSING -> PENDING (retry scheduled via BullMQ): eventId=${eventId} attempts=${updated.attempts}/${updated.maxAttempts}`,
      );
      return { outcome: 'retry-scheduled' as const, event: updated };
    });
  }

  /**
   * CAS `PROCESSING -> FAILED`. `failureType` is now caller-supplied (retry/backoff design,
   * R2) — `'PERMANENT'` for a non-retryable business rejection, `'RETRYABLE'` for a transient
   * failure whose attempt budget is exhausted (database-design.md §4/§7's existing
   * `RETRYABLE|PERMANENT` CHECK constraint already anticipates exactly these two values; no
   * schema change was needed to support this). `result` is deliberately left untouched (stays
   * `NULL`) — only a SUCCEEDED event has one.
   */
  private async finalizeFailure(
    eventId: string,
    failureReason: string,
    failureType: 'PERMANENT' | 'RETRYABLE',
  ): Promise<ProcessEventResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          failureReason,
          failureType,
          processingFinishedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        this.logger.warn(`PROCESSING -> FAILED CAS matched no row: eventId=${eventId}`);
        return { outcome: 'lost-race' as const };
      }

      const updated = await tx.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });

      await tx.eventStatusHistory.create({
        data: {
          eventId,
          fromStatus: 'PROCESSING',
          toStatus: 'FAILED',
          attemptNumber: updated.attempts,
          errorMessage: failureReason,
        },
      });

      this.logger.warn(`PROCESSING -> FAILED: eventId=${eventId} reason=${failureReason}`);
      return { outcome: 'failed' as const, event: updated };
    });
  }

  /**
   * Backstop reconciliation (retry/backoff design, R3). Called ONLY by the BullMQ `failed`
   * event listener (payroll-event-failed-backstop.ts), and ONLY when BullMQ itself has
   * already determined the job is exhausted (`job.attemptsMade >= job.opts.attempts`) — this
   * is NOT the primary exhaustion mechanism. `runProviderAndFinalize`'s own
   * attempts-vs-maxAttempts check (R2) already finalizes the normal case, and does so
   * *before* the processor ever throws, so BullMQ's `failed` event does not even fire for a
   * normal R2 exhaustion (the processor returns without throwing). This method exists only
   * for the residual gap where BullMQ considers a job exhausted but the normal processor
   * path never persisted a terminal state — e.g. an unexpected error after the claim
   * committed but before `runProviderAndFinalize` could finish. It is deliberately named
   * "reconcile", not "sweep" — this is a single, event-driven, per-job check triggered by one
   * BullMQ `failed` event, not the periodic, all-`PENDING`-rows reconciliation *sweep*
   * architecture.md §15 describes for the DB-commit/enqueue gap; the two are unrelated
   * mechanisms for unrelated problems and must not be conflated.
   *
   * Idempotent and safe regardless of the event's actual current state:
   *   - missing / SUCCEEDED / FAILED: no-op, returns `false` — nothing to reconcile.
   *   - `PENDING`: no-op, returns `false` — see below for why this is correct, not overlooked.
   *   - `PROCESSING`: the one case this backstop actually acts on — finalizes to
   *     `FAILED`/`RETRYABLE` via the same guarded CAS + atomic history insert as every other
   *     worker-side transition (`finalizeFailure`, reused as-is).
   *
   * Why `PENDING` is a no-op, not forced to `FAILED`: in this system's design, an event only
   * returns to `PENDING` via `retryTransition`, which commits *before* the processor throws
   * — so by the time BullMQ's `failed` event fires for that delivery, the DB has already
   * moved on from `PROCESSING`. If this backstop finds the event `PENDING`, that is either
   * (a) the normal, expected R2 case — the event is legitimately waiting for its next
   * BullMQ-scheduled retry — or (b) something else has already reclaimed it. Neither case is
   * safe to force to `FAILED`: doing so could terminate an event that still has a
   * legitimately scheduled retry coming, or race with a concurrent claim. Doing nothing is
   * the correct, safe choice here, not an oversight.
   *
   * Does not increment or otherwise touch `attempts` — that column's meaning (successful
   * `PENDING -> PROCESSING` claims) is unchanged by this method, and BullMQ's own
   * `attemptsMade` is never written into it (retry/backoff design's explicit constraint).
   *
   * @returns `true` if this call actually finalized the event, `false` if it found nothing
   * to reconcile (including losing a race, which is exactly as safe as any other CAS miss).
   */
  async reconcileExhaustedJob(eventId: string): Promise<boolean> {
    const event = await this.prisma.payrollEvent.findUnique({ where: { id: eventId } });

    if (!event) {
      this.logger.warn(`backstop: event not found, nothing to reconcile: eventId=${eventId}`);
      return false;
    }

    if (event.status !== 'PROCESSING') {
      this.logger.log(
        `backstop: event is ${event.status}, not PROCESSING — no reconciliation needed: eventId=${eventId}`,
      );
      return false;
    }

    const result = await this.finalizeFailure(
      eventId,
      'Processing exhausted its retry budget at the queue layer without the worker persisting a terminal state.',
      'RETRYABLE',
    );

    if (result.outcome === 'lost-race') {
      this.logger.log(
        `backstop: CAS lost, event already left PROCESSING by another writer: eventId=${eventId}`,
      );
      return false;
    }

    this.logger.warn(`backstop: finalized event as FAILED/RETRYABLE: eventId=${eventId}`);
    return true;
  }
}
