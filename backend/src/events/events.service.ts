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

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The submission transaction (architecture.md §17 / database-design.md §12): advisory
   * lock → sequence allocation → insert `payroll_events` (status defaults to PENDING) →
   * insert its first `event_status_history` row, all in one short transaction with no
   * external call inside it. No queue enqueue happens here — that is Phase 4's job.
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
      return { event: created, deduplicated: false };
    } catch (err) {
      if (isUniqueConstraintViolationOn(err, 'idempotency_key')) {
        return this.resolveDuplicateSubmission(idempotencyKey, eventType, payload);
      }
      throw err;
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
