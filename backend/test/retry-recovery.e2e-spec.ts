import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  REDIS_CONNECTION,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { EventProcessingService } from '../src/processing/event-processing.service';
import { StaleProcessingSweepService } from '../src/processing/stale-processing-sweep.service';
import { PayrollEventsQueueService } from '../src/processing/payroll-events-queue.service';
import { SimulatedPayrollProvider } from '../src/processing/simulated-payroll-provider';
import type { Queue } from 'bullmq';

/**
 * Retry/backoff design, R4 — stale-processing crash recovery. Runs against real PostgreSQL
 * AND real Redis/BullMQ.
 *
 * `STALE_PROCESSING_TIMEOUT_MS` is 2 real minutes — these tests never wait that long. Instead
 * they seed events with a `processingStartedAt` already in the past (a controlled, fixed
 * fixture timestamp, not a sleep), and call `StaleProcessingSweepService.runSweep()` directly
 * rather than waiting for its internal setInterval to fire — both are exactly the "controlled
 * timestamps / deterministic fixtures" the R4 spec asks for, avoiding any wall-clock-based
 * flakiness.
 */
describe('Retry/backoff R4: stale-processing crash recovery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let queue: Queue;
  let eventProcessingService: EventProcessingService;
  let queueService: PayrollEventsQueueService;
  let sweepService: StaleProcessingSweepService;

  const runPrefix = `recovery-test-${randomUUID()}`;
  const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;

  // A processingStartedAt safely past the 2-minute staleness threshold — a fixed fixture
  // value, not a real elapsed wait.
  const staleTimestamp = () => new Date(Date.now() - 3 * 60 * 1000);
  const freshTimestamp = () => new Date();

  const seedEvent = (overrides: Partial<Record<string, unknown>> = {}) =>
    prisma.payrollEvent.create({
      data: {
        employeeId: employeeId(`seed-${randomUUID()}`),
        eventType: 'ADDRESS_CHANGE',
        sequence: 1,
        idempotencyKey: `${runPrefix}-idem-${randomUUID()}`,
        payload: { effectiveDate: '2026-01-01', street: '1 Example Street' },
        status: 'PROCESSING',
        maxAttempts: 5,
        processingStartedAt: staleTimestamp(),
        ...overrides,
      },
    });

  const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitUntil: condition not met within timeout');
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(REDIS_CONNECTION);
    queue = app.get(PAYROLL_EVENTS_QUEUE);
    queueService = app.get(PayrollEventsQueueService);
    eventProcessingService = new EventProcessingService(prisma, new SimulatedPayrollProvider());
    // Constructed directly (not via DI) so runSweep() can be called on demand instead of
    // waiting for its internal setInterval — the same "construct the service directly for a
    // deterministic test" technique used throughout this test suite.
    sweepService = new StaleProcessingSweepService(prisma, eventProcessingService, queueService);
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('A. Stale detection', () => {
    it('a fresh PROCESSING event is NOT touched by the sweep', async () => {
      const event = await seedEvent({ processingStartedAt: freshTimestamp() });

      await sweepService.runSweep();

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('PROCESSING');
      const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
      expect(history).toBe(0);
    });

    it('a stale PROCESSING event IS recovered by the sweep', async () => {
      const event = await seedEvent({ processingStartedAt: staleTimestamp() });

      await sweepService.runSweep();

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('PENDING');
    });
  });

  describe('B. Safe recovery', () => {
    it('stale PROCESSING -> PENDING: exactly one history row, attempts unchanged', async () => {
      const event = await seedEvent({ attempts: 2, maxAttempts: 5 });

      const result = await eventProcessingService.recoverStaleProcessing(event.id);
      expect(result.outcome).toBe('retry-scheduled');

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('PENDING');
      expect(after.attempts).toBe(2); // unchanged — only a successful claim increments this

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: 'PROCESSING',
        toStatus: 'PENDING',
        attemptNumber: 2,
      });
    });
  });

  describe('C. Re-enqueue', () => {
    it('a recovered stale event produces a real BullMQ job with jobId = eventId and minimal { eventId } payload', async () => {
      const event = await seedEvent({ attempts: 1, maxAttempts: 5 });

      await sweepService.runSweep();

      const job = await queue.getJob(event.id);
      expect(job).toBeDefined();
      expect(job?.id).toBe(event.id);
      expect(job?.data).toEqual({ eventId: event.id });
    });
  });

  describe('D. Reprocessing (real worker)', () => {
    it('a recovered event can be reclaimed by a real worker; the next successful claim increments attempts exactly once from its pre-crash value', async () => {
      const event = await seedEvent({
        employeeId: employeeId('reprocess'),
        attempts: 2,
        maxAttempts: 5,
      });

      const worker = new Worker(
        PAYROLL_EVENTS_QUEUE_NAME,
        createPayrollEventProcessor(eventProcessingService),
        { connection: redis, concurrency: 5 },
      );
      await worker.waitUntilReady();

      try {
        await sweepService.runSweep(); // recovers PROCESSING -> PENDING and re-enqueues

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'SUCCEEDED';
        });

        const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(final.attempts).toBe(3); // 2 (pre-crash) + 1 (the reclaim) — not reset to 1

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { occurredAt: 'asc' },
        });
        expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
          'PROCESSING->PENDING', // recovery
          'PENDING->PROCESSING', // reclaim
          'PROCESSING->SUCCEEDED', // normal finish
        ]);
      } finally {
        await worker.close();
      }
    });
  });

  describe('E. Exhaustion', () => {
    it('a stale event whose attempt budget is already exhausted is finalized FAILED/RETRYABLE, not returned to PENDING — no re-enqueue, no 6th claim possible', async () => {
      const event = await seedEvent({ attempts: 5, maxAttempts: 5 });

      await sweepService.runSweep();

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FAILED');
      expect(after.failureType).toBe('RETRYABLE');
      expect(after.attempts).toBe(5); // unchanged, never a 6th claim
      expect(after.result).toBeNull();

      const job = await queue.getJob(event.id);
      expect(job).toBeUndefined(); // never re-enqueued
    });
  });

  describe('F. Terminal states', () => {
    it.each(['SUCCEEDED', 'FAILED'])(
      'recoverStaleProcessing is a no-op for an already-%s event, even with a stale timestamp',
      async (status) => {
        const event = await seedEvent({
          status,
          attempts: 3,
          processingFinishedAt: new Date(),
          ...(status === 'FAILED' ? { failureType: 'PERMANENT', failureReason: 'x' } : {}),
        });

        const result = await eventProcessingService.recoverStaleProcessing(event.id);

        expect(result.outcome).toBe('not-processing');
        const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(after.status).toBe(status);
      },
    );
  });

  describe('G. Concurrency / race safety', () => {
    it("once stale recovery wins, a legitimate worker's own late finalize attempt safely finds nothing to update (does not overwrite PENDING)", async () => {
      const event = await seedEvent({ attempts: 1, maxAttempts: 5 });

      const recoveryResult = await eventProcessingService.recoverStaleProcessing(event.id);
      expect(recoveryResult.outcome).toBe('retry-scheduled');

      // Simulates the "legitimate" worker A — unaware recovery already ran — finally trying
      // to persist its own real success. Its CAS is gated on status='PROCESSING', which is
      // no longer true; this is the exact same guard finalizeSuccess uses internally.
      const lateFinalize = await prisma.payrollEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING' },
        data: { status: 'SUCCEEDED', result: { ok: true }, processingFinishedAt: new Date() },
      });

      expect(lateFinalize.count).toBe(0); // its CAS correctly finds nothing to update
      const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(final.status).toBe('PENDING'); // recovery's transition stands, not silently overwritten
    });

    it('a genuinely concurrent race between stale recovery and a legitimate finalize produces exactly one winner, never a corrupted state', async () => {
      const event = await seedEvent({ attempts: 1, maxAttempts: 5 });

      // Simulates the "legitimate" worker A's own real finalizeSuccess — same CAS guard,
      // same atomic history insert, just written out here since that method is private.
      const simulateLegitimateFinalize = () =>
        prisma.$transaction(async (tx) => {
          const { count } = await tx.payrollEvent.updateMany({
            where: { id: event.id, status: 'PROCESSING' },
            data: { status: 'SUCCEEDED', result: { ok: true }, processingFinishedAt: new Date() },
          });
          if (count > 0) {
            await tx.eventStatusHistory.create({
              data: {
                eventId: event.id,
                fromStatus: 'PROCESSING',
                toStatus: 'SUCCEEDED',
                attemptNumber: 1,
              },
            });
          }
          return count;
        });

      const [recoveryResult, finalizeCount] = await Promise.all([
        eventProcessingService.recoverStaleProcessing(event.id),
        simulateLegitimateFinalize(),
      ]);

      const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(['SUCCEEDED', 'PENDING']).toContain(final.status);

      if (final.status === 'SUCCEEDED') {
        // Finalize won. Depending on exactly how the two calls interleaved, recovery either
        // attempted its CAS and lost ('lost-race'), or its own initial read already observed
        // the post-finalize state before attempting any write ('not-processing') — both are
        // safe, correct "recovery did nothing" outcomes; neither ever overwrites SUCCEEDED.
        expect(['lost-race', 'not-processing']).toContain(recoveryResult.outcome);
        expect(finalizeCount).toBe(1);
      } else {
        expect(finalizeCount).toBe(0);
        expect(recoveryResult.outcome).toBe('retry-scheduled');
      }

      // Exactly one transition was ever recorded — never both, never zero.
      const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
      expect(history).toBe(1);
    });
  });

  describe('H. R3 compatibility', () => {
    it('R3 (BullMQ-exhaustion backstop) and R4 (stale-processing sweep) racing to reconcile the same stuck event produce exactly one transition, no duplicate history', async () => {
      const event = await seedEvent({ attempts: 5, maxAttempts: 5 });

      const [backstopReconciled, staleRecoveryResult] = await Promise.all([
        eventProcessingService.reconcileExhaustedJob(event.id), // R3
        eventProcessingService.recoverStaleProcessing(event.id), // R4
      ]);

      const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(final.status).toBe('FAILED');
      expect(final.failureType).toBe('RETRYABLE');

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(1); // only one of the two writes actually committed

      const winners = [backstopReconciled, staleRecoveryResult.outcome === 'failed'].filter(
        Boolean,
      );
      expect(winners).toHaveLength(1);
    });
  });

  describe('I. Repeated reconciliation', () => {
    it('running the sweep repeatedly over the same stale candidate is safe: no duplicate history, no duplicate re-enqueue', async () => {
      const event = await seedEvent({ attempts: 1, maxAttempts: 5 });

      await sweepService.runSweep(); // recovers PROCESSING -> PENDING, re-enqueues
      await sweepService.runSweep(); // event is now PENDING — no longer a PROCESSING candidate
      await sweepService.runSweep();

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('PENDING');

      const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
      expect(history).toBe(1); // still exactly one transition, not three
    });
  });
});
