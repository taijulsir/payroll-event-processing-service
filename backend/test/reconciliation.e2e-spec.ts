import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Worker, type Queue } from 'bullmq';
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
import { PayrollEventsQueueService } from '../src/processing/payroll-events-queue.service';
import { SimulatedPayrollProvider } from '../src/processing/simulated-payroll-provider';
import { ReconciliationSweepService } from '../src/processing/reconciliation-sweep.service';

/**
 * Reconciliation design (architecture.md §15, database-design.md §14/§8/§18) — the DB-commit
 * → queue-enqueue gap sweep. Runs against real PostgreSQL AND real Redis/BullMQ.
 *
 * `RECONCILIATION_AGE_THRESHOLD_MS` is 5 real minutes — these tests never wait that long.
 * Instead they seed events with a `submittedAt` already in the past (a controlled, fixed
 * fixture timestamp, not a sleep), and call `ReconciliationSweepService.runSweep()` directly
 * rather than waiting for its internal setInterval to fire — the same deterministic-fixture
 * technique R4's own e2e suite (`retry-recovery.e2e-spec.ts`) uses for its analogous sweep.
 */
describe('Reconciliation: DB-commit -> queue-enqueue gap sweep', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let queue: Queue;
  let queueService: PayrollEventsQueueService;
  let eventProcessingService: EventProcessingService;
  let sweepService: ReconciliationSweepService;

  const runPrefix = `reconciliation-test-${randomUUID()}`;
  const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;

  // A submittedAt safely past the 5-minute age threshold — a fixed fixture value, not a real
  // elapsed wait.
  const oldTimestamp = () => new Date(Date.now() - 6 * 60 * 1000);
  const freshTimestamp = () => new Date();

  const seedEvent = (overrides: Partial<Record<string, unknown>> = {}) =>
    prisma.payrollEvent.create({
      data: {
        employeeId: employeeId(`seed-${randomUUID()}`),
        eventType: 'ADDRESS_CHANGE',
        sequence: 1,
        idempotencyKey: `${runPrefix}-idem-${randomUUID()}`,
        payload: { effectiveDate: '2026-01-01', street: '1 Example Street' },
        status: 'PENDING',
        maxAttempts: 5,
        submittedAt: oldTimestamp(),
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
    // waiting for its internal setInterval — the same technique used throughout R4's suite.
    sweepService = new ReconciliationSweepService(prisma, queueService);
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('A. Age threshold', () => {
    it('an old PENDING event with no BullMQ job gets re-enqueued', async () => {
      const event = await seedEvent(); // default: old submittedAt, PENDING

      const before = await queue.getJob(event.id);
      expect(before).toBeUndefined();

      await sweepService.runSweep();

      const job = await queue.getJob(event.id);
      expect(job).toBeDefined();
      expect(job?.id).toBe(event.id);
      expect(job?.data).toEqual({ eventId: event.id }); // minimal payload, jobId = eventId
    });

    it('a newly-created PENDING event is not prematurely re-enqueued', async () => {
      const event = await seedEvent({ submittedAt: freshTimestamp() });

      await sweepService.runSweep();

      const job = await queue.getJob(event.id);
      expect(job).toBeUndefined();
    });
  });

  describe('B. Only PENDING events are ever candidates', () => {
    it.each(['SUCCEEDED', 'FAILED', 'PROCESSING'])(
      'a %s event, even with an old submittedAt, is ignored — never re-enqueued',
      async (status) => {
        const event = await seedEvent({
          status,
          ...(status === 'PROCESSING' ? { processingStartedAt: oldTimestamp() } : {}),
          ...(status === 'FAILED' ? { failureType: 'PERMANENT', failureReason: 'x' } : {}),
        });

        await sweepService.runSweep();

        const job = await queue.getJob(event.id);
        expect(job).toBeUndefined();
      },
    );
  });

  describe('C. Existing job / duplicate safety', () => {
    it('an existing BullMQ job for the candidate is never duplicated, and no second business event is ever created', async () => {
      const event = await seedEvent();
      await queueService.enqueue(event.id); // simulate the original enqueue actually having succeeded
      const beforeJob = await queue.getJob(event.id);
      expect(beforeJob).toBeDefined();

      await sweepService.runSweep(); // must be a safe, harmless re-attempt (BullMQ's own jobId dedup)

      const afterJob = await queue.getJob(event.id);
      expect(afterJob).toBeDefined();
      expect(afterJob?.id).toBe(event.id); // same job identity, not a second one

      const rowCount = await prisma.payrollEvent.count({ where: { id: event.id } });
      expect(rowCount).toBe(1); // reconciliation never inserts/duplicates a payroll_events row
    });
  });

  describe('D. Enqueue failure', () => {
    it('an enqueue failure during the sweep leaves the event PENDING, untouched, and recoverable by the next run', async () => {
      const event = await seedEvent();
      const failingQueue = {
        enqueue: jest.fn().mockRejectedValue(new Error('Redis unreachable (simulated)')),
      } as unknown as PayrollEventsQueueService;
      const failingSweep = new ReconciliationSweepService(prisma, failingQueue);

      await expect(failingSweep.runSweep()).resolves.toBeUndefined(); // does not throw

      const afterFailure = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(afterFailure.status).toBe('PENDING'); // no fake PROCESSING/FAILED transition
      expect(afterFailure.attempts).toBe(0);

      // The next run, using the real queue service, can still recover it.
      await sweepService.runSweep();
      const job = await queue.getJob(event.id);
      expect(job).toBeDefined();
    });
  });

  describe('E. Repeated and concurrent safety', () => {
    it('running the sweep repeatedly over the same candidate is safe: exactly one job, no history, event stays PENDING', async () => {
      const event = await seedEvent();

      await sweepService.runSweep();
      await sweepService.runSweep();
      await sweepService.runSweep();

      const job = await queue.getJob(event.id);
      expect(job).toBeDefined();
      const row = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe('PENDING'); // the sweep itself never transitions status
      const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
      expect(history).toBe(0); // enqueueing is not a state transition
    });

    it('two concurrent sweep runs over the same candidate remain safe', async () => {
      const event = await seedEvent();

      await Promise.all([sweepService.runSweep(), sweepService.runSweep()]);

      const job = await queue.getJob(event.id);
      expect(job).toBeDefined();
      const row = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe('PENDING');
    });
  });

  describe('F. No provider invocation from reconciliation itself', () => {
    it('reconciliation never invokes the provider — no claim, no attempts increment, no history row', async () => {
      const event = await seedEvent();

      await sweepService.runSweep();

      const row = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe('PENDING');
      // The provider is only ever reachable via a successful claim CAS (PENDING -> PROCESSING),
      // which increments `attempts` — this stayed 0, so the sweep could not have invoked it.
      expect(row.attempts).toBe(0);
      expect(row.result).toBeNull();
      const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
      expect(history).toBe(0); // no state transition was ever recorded by the sweep
    });
  });

  describe('G. End-to-end: a reconciled event is processed normally', () => {
    it('a reconciled event is claimed and processed to completion by a real worker', async () => {
      const event = await seedEvent();

      const worker = new Worker(
        PAYROLL_EVENTS_QUEUE_NAME,
        createPayrollEventProcessor(eventProcessingService),
        { connection: redis, concurrency: 5 },
      );
      await worker.waitUntilReady();

      try {
        await sweepService.runSweep(); // the only enqueue this event ever gets

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'SUCCEEDED';
        });

        const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(final.attempts).toBe(1); // one real claim, by the worker — not the sweep

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { occurredAt: 'asc' },
        });
        expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
          'PENDING->PROCESSING',
          'PROCESSING->SUCCEEDED',
        ]);
      } finally {
        await worker.close();
      }
    });
  });
});
