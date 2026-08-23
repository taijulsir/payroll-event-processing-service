import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type EventStatusHistory, type PayrollEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { allocateNextSequence } from './sequence-allocation';
import { isUniqueConstraintViolationOn } from './prisma-errors.util';
import { DEFAULT_MAX_ATTEMPTS } from './events.constants';
import { DEFAULT_LIST_LIMIT, ListEventsQueryDto } from './dto/list-events-query.dto';
import { PayrollEventsQueueService } from '../processing/payroll-events-queue.service';

export interface ListEventsResult {
  items: PayrollEvent[];
  total: number;
}

export interface SubmitEventResult {
  event: PayrollEvent;
  /** True when this call returned a pre-existing event rather than creating a new one. */
  deduplicated: boolean;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PayrollEventsQueueService,
  ) {}

  /**
   * The submission transaction (architecture.md §17 / database-design.md §12): advisory
   * lock → sequence allocation → insert `payroll_events` (status defaults to PENDING) →
   * insert its first `event_status_history` row, all in one short transaction with no
   * external call inside it — this includes the BullMQ enqueue below, which happens only
   * after this method's `$transaction(...)` call has returned, i.e. strictly after commit.
   * Redis is never touched while the Postgres transaction is open (architecture.md §9: "the
   * API, after its submission transaction commits (never inside it — Redis is not
   * transactional with Postgres)").
   *
   * Idempotency is enforced by `UNIQUE(idempotency_key)` (database-design.md §7/§10), not
   * by checking for existence before inserting: the insert is always attempted, and only a
   * unique-constraint violation on that specific column is treated as "this key was already
   * used," at which point the existing row is looked up and returned. This is what makes it
   * safe under concurrent identical requests — whichever insert commits first wins, and the
   * loser recovers by reading, rather than by having pre-checked and racing anyway.
   */
  async submit(
    idempotencyKey: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<SubmitEventResult> {
    const employeeId = payload.employeeId as string;
    let result: SubmitEventResult;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const sequence = await allocateNextSequence(tx, employeeId);

        const event = await tx.payrollEvent.create({
          data: {
            employeeId,
            eventType,
            sequence,
            idempotencyKey,
            payload: payload as Prisma.InputJsonValue,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
          },
        });

        await tx.eventStatusHistory.create({
          data: { eventId: event.id, fromStatus: null, toStatus: 'PENDING' },
        });

        return event;
      });

      this.logger.log(
        `event accepted: id=${created.id} employeeId=${created.employeeId} eventType=${created.eventType} sequence=${created.sequence}`,
      );
      result = { event: created, deduplicated: false };
    } catch (err) {
      if (isUniqueConstraintViolationOn(err, 'idempotency_key')) {
        result = await this.resolveDuplicateSubmission(idempotencyKey, eventType, payload);
      } else {
        throw err;
      }
    }

    // Strictly after the transaction above has committed (or, for a duplicate, after the
    // pre-existing row was read back) — never inside it. Safe to attempt even for a
    // deduplicated event: jobId = event.id makes a redundant enqueue a harmless no-op
    // (PayrollEventsQueueService), so this doubles as an opportunistic retry of the enqueue
    // step for an earlier submission whose own enqueue may have failed.
    await this.enqueueSafely(result.event.id);

    return result;
  }

  /**
   * Enqueues the BullMQ job for an already-committed event, without ever failing the
   * request or rolling back the (already-durable) event if this fails.
   *
   * This is the documented DB-commit → Redis-enqueue gap (architecture.md §15): the two
   * systems have no shared transaction, so a crash or Redis outage between commit and
   * enqueue is an accepted, designed-for possibility, not an error condition to surface to
   * the client — the event is genuinely, durably PENDING regardless of whether this
   * particular call succeeds. The (not-yet-implemented) reconciliation sweep is what
   * eventually re-enqueues an event that fell through this gap; this method's only
   * responsibility on failure is to make that gap loudly visible in the logs, not to pretend
   * it can roll back a commit that has already happened.
   */
  private async enqueueSafely(eventId: string): Promise<void> {
    try {
      await this.queue.enqueue(eventId);
    } catch (err) {
      this.logger.error(
        `enqueue failed for event ${eventId} — event remains PENDING in PostgreSQL and is ` +
          `recoverable by the future reconciliation sweep (architecture.md §15): ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Reached only after a unique-violation on `idempotency_key`. Looks up the event that
   * actually won the insert and decides whether this request is a legitimate retry (same
   * logical request — return it, per architecture.md §10: "safe to retry any number of
   * times") or a reuse of the same key for a materially different request. The latter isn't
   * addressed by name in the assignment/architecture/database-design docs; the simplest
   * defensible behavior — and the one architecture.md §6 already reserves a status code for
   * ("409 reserved for any future explicit conflict case (not currently used)") — is to
   * reject it as a conflict rather than silently either overwriting or returning the wrong
   * event.
   */
  private async resolveDuplicateSubmission(
    idempotencyKey: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<SubmitEventResult> {
    const existing = await this.prisma.payrollEvent.findUnique({ where: { idempotencyKey } });

    if (!existing) {
      // The row that caused the violation is gone by the time we looked — not expected in
      // this system (nothing deletes events), but must not be misreported as a client error.
      throw new InternalServerErrorException(
        'Failed to resolve event after an idempotency-key conflict',
      );
    }

    const sameLogicalRequest =
      existing.eventType === eventType && isDeepStrictEqual(existing.payload, payload);

    if (!sameLogicalRequest) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different request payload',
      );
    }

    this.logger.log(`duplicate submission resolved to existing event: id=${existing.id}`);
    return { event: existing, deduplicated: true };
  }

  /**
   * GET /events/:id's data access. No processing/business logic — events are always
   * PENDING at this phase (queue/worker processing is a later phase). Returns `null` for a
   * missing event; the controller is responsible for turning that into a 404.
   */
  async findById(id: string): Promise<PayrollEvent | null> {
    return this.prisma.payrollEvent.findUnique({ where: { id } });
  }

  /** The full, ordered audit trail for one event — architecture.md §6's "status history". */
  async findHistory(eventId: string): Promise<EventStatusHistory[]> {
    return this.prisma.eventStatusHistory.findMany({
      where: { eventId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * GET /events's data access — architecture.md §6: "List events (filter by
   * employeeId/status, simple pagination)". A plain `where` + `skip`/`take`, nothing more:
   * no search, no sorting options, no cursor pagination. `findMany` and `count` run in one
   * `$transaction` (array form) purely so `total` reflects the same snapshot as `items`,
   * not because this list needs any stronger consistency guarantee than that.
   */
  async findMany(query: ListEventsQueryDto): Promise<ListEventsResult> {
    const where: Prisma.PayrollEventWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status) where.status = query.status;

    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.payrollEvent.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.payrollEvent.count({ where }),
    ]);

    return { items, total };
  }
}
