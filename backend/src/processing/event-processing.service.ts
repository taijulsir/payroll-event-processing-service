import { Injectable, Logger } from '@nestjs/common';
import type { PayrollEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What actually happened when a job's event was looked at. Every branch is a legitimate,
 * expected outcome — not one of them represents an error. `processEvent()` never throws for
 * any of these; only a genuinely unexpected failure (e.g. a database error) propagates as a
 * real exception, left to the caller (the BullMQ processor) to log and let BullMQ mark the
 * job failed.
 */
export type ProcessEventOutcome =
  | 'claimed' // PENDING -> PROCESSING succeeded, this job won the claim
  | 'terminal' // event was already SUCCEEDED or FAILED — safe no-op
  | 'already-processing' // event was already PROCESSING — safe no-op
  | 'lost-race' // event was PENDING at read time, but another worker claimed it first
  | 'missing'; // no event exists for this id

export interface ProcessEventResult {
  outcome: ProcessEventOutcome;
  event?: PayrollEvent;
}

/**
 * The worker-side event lifecycle logic (architecture.md §8/§11/§17, database-design.md
 * §11/§12/§13/§18). This phase implements exactly one transition: PENDING -> PROCESSING.
 *
 * Postgres is the only source of truth here — the caller passes nothing but an `eventId`;
 * this service never trusts status/payload carried on the BullMQ job itself.
 *
 * Deliberately NOT part of EventsService: that class is the HTTP-submission surface
 * (controller -> service -> Prisma); this one is the worker-processing surface
 * (processor -> service -> Prisma). Keeping them separate matches the module boundary
 * architecture.md draws between EventsModule and ProcessingModule.
 */
@Injectable()
export class EventProcessingService {
  private readonly logger = new Logger(EventProcessingService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      // any provider, must not change the event, and must not be treated as an error.
      this.logger.log(`terminal state, no-op: eventId=${eventId} status=${event.status}`);
      return { outcome: 'terminal', event };
    }

    if (event.status === 'PROCESSING') {
      // Already being (or already was) processed by some worker. This phase implements no
      // transition out of PROCESSING and no crash-recovery beyond the CAS guard below, so
      // there is nothing safe to do here except observe and exit.
      this.logger.log(`already PROCESSING, no-op: eventId=${eventId}`);
      return { outcome: 'already-processing', event };
    }

    // event.status === 'PENDING' here. This read is only used to decide which branch above
    // applies and to avoid attempting a pointless write when we already know the event is
    // terminal or already claimed — it is NOT the correctness mechanism. Between this read
    // and the CAS update below, any other worker could have already changed the row; that is
    // fine, because the update's own WHERE clause is what actually decides the outcome, not
    // what we observed a moment ago.
    return this.claimForProcessing(eventId);
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
   * itself the atomic guard (Postgres can only ever let one concurrent UPDATE matching
   * `id = ... AND status = 'PENDING'` succeed; every other concurrent attempt matches zero
   * rows), and its returned `count` is how we detect whether *this* call was the one that
   * won — the same technique the literal `UPDATE ... RETURNING *` in the docs uses, just
   * through Prisma's query builder instead of a hand-written statement. Raw SQL stays
   * reserved for the one place Prisma's builder genuinely cannot express something (the
   * per-employee advisory lock in sequence-allocation.ts) — this operation doesn't need it.
   *
   * The update and the append-only history insert happen inside the same transaction
   * (database-design.md §12: "insert history row... payroll_events (update),
   * event_status_history (insert)") — either both commit or neither does.
   */
  private async claimForProcessing(eventId: string): Promise<ProcessEventResult> {
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
        // Another worker's CAS won the race between our read and this update. Expected under
        // concurrent processing, not an error (database-design.md §13).
        this.logger.log(`PENDING -> PROCESSING lost race: eventId=${eventId}`);
        return { outcome: 'lost-race' as const };
      }

      // Read the row back (within the same transaction, so it sees our own uncommitted
      // write) purely to get the post-increment `attempts` value for the history row and for
      // the return value — this read is not part of the atomicity guarantee, the `updateMany`
      // above already is.
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
}
