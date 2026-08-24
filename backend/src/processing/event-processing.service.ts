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
  | 'failed' // PROCESSING -> FAILED, same as above but the provider returned a failure
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
 * database-design.md §11/§12/§13/§18). Implements the full non-retry lifecycle:
 *
 *   PENDING -> PROCESSING -> SUCCEEDED (provider succeeds)
 *                          -> FAILED   (provider fails)
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

    // R1 (retry/backoff design, Phase R1 — provider failure classification): the provider
    // now reports `outcome.classification` ('TRANSIENT' | 'PERMANENT'), but this phase is
    // scoped to that classification existing and being deterministic, not to acting on it.
    // Every failure — regardless of classification — is still finalized straight to
    // FAILED/PERMANENT below, exactly as before this field existed. Reacting differently to
    // 'TRANSIENT' (returning to PENDING, checking attempts against maxAttempts, etc.) is R2's
    // job, not this one's.
    this.logger.warn(
      `provider failed: eventId=${event.id} classification=${outcome.classification} reason=${outcome.failureReason}`,
    );
    return this.finalizeFailure(event.id, outcome.failureReason);
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
   * CAS `PROCESSING -> FAILED`. `failureType` is set to `'PERMANENT'` — the only fitting
   * value available in the schema's existing `RETRYABLE|PERMANENT` model (database-design.md
   * §4/§7's CHECK constraint) for a failure this phase treats as immediately terminal: no
   * retry policy exists yet in this increment (explicitly out of scope), so nothing is ever
   * "exhausted" here the way `RETRYABLE` implies (architecture.md §13). This is a deliberate,
   * documented implementation decision for this phase, not a claim that every future failure
   * will be `PERMANENT` — the retry-policy phase is expected to introduce the
   * throw-vs-catch split that produces `RETRYABLE` outcomes too, without changing this schema.
   * `result` is deliberately left untouched (stays `NULL`) — only a SUCCEEDED event has one.
   */
  private async finalizeFailure(
    eventId: string,
    failureReason: string,
  ): Promise<ProcessEventResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          failureReason,
          failureType: 'PERMANENT',
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
}
