import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  PAYROLL_EVENTS_JOB_ATTEMPTS,
  PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS,
  PROCESS_PAYROLL_EVENT_JOB_NAME,
  REDIS_CONNECTION,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { EventProcessingService } from '../src/processing/event-processing.service';
import {
  FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER,
  SimulatedPayrollProvider,
} from '../src/processing/simulated-payroll-provider';
import type {
  PayrollProvider,
  PayrollProviderInput,
  PayrollProviderOutcome,
} from '../src/processing/payroll-provider';

/**
 * Retry/backoff design, R2 — retry transition + attempt budget + BullMQ native
 * attempts/backoff. Runs against real PostgreSQL AND real Redis/BullMQ.
 *
 * Success and permanent-failure flows are already covered end-to-end (real worker, real
 * provider) in test/payroll-provider.e2e-spec.ts and are unaffected by this phase's changes —
 * not duplicated here. This file covers only what's new: BullMQ's own job-level retry
 * configuration, the transient-failure retry cycle through real redelivery/backoff, attempt
 * budget exhaustion, and duplicate/terminal safety involving the new PROCESSING -> PENDING
 * transition.
 *
 * The full 5-attempt exhaustion cycle uses a per-job backoff override (short, fixed-formula
 * exponential delay) added directly via the raw Queue — NOT the production
 * `defaultJobOptions` (2000ms base, verified separately and exactly in its own fast test) —
 * so this test finishes in well under a second instead of requiring the real ~30s a full
 * 2000ms-base exponential cycle would take. `attempts` still matches the DB's `maxAttempts`
 * (5) so BullMQ's own delivery budget and the business attempt budget stay in lockstep for
 * this test, exercising the intended, non-diverging exhaustion path.
 */
describe('Retry/backoff: transient failure retry transition + attempt budget', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let queue: Queue;
  let worker: Worker;
  let eventProcessingService: EventProcessingService;

  const runPrefix = `retry-test-${randomUUID()}`;
  const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;

  const addressPayload = (overrides: Record<string, unknown> = {}) => ({
    eventType: 'ADDRESS_CHANGE',
    employeeId: employeeId('addr'),
    effectiveDate: '2026-01-01',
    street: '1 Example Street',
    city: 'Berlin',
    postalCode: '10115',
    country: 'DE',
    ...overrides,
  });

  const submit = (payload: Record<string, unknown>, key = `${runPrefix}-idem-${randomUUID()}`) =>
    request(app.getHttpServer()).post('/events').set('Idempotency-Key', key).send(payload);

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

  /** Wraps a real (or fixed-outcome) provider, counting how many times it was actually invoked. */
  class CountingProvider implements PayrollProvider {
    calls = 0;
    constructor(private readonly inner: PayrollProvider) {}
    async apply(input: PayrollProviderInput): Promise<PayrollProviderOutcome> {
      this.calls += 1;
      return this.inner.apply(input);
    }
  }

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
    eventProcessingService = new EventProcessingService(prisma, new SimulatedPayrollProvider());

    // A real BullMQ Worker, built the same way WorkerProcessingModule builds one in
    // worker.ts, with the real (not mocked) SimulatedPayrollProvider wired in.
    worker = new Worker(
      PAYROLL_EVENTS_QUEUE_NAME,
      createPayrollEventProcessor(eventProcessingService),
      { connection: redis, concurrency: 5 },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('A. BullMQ job configuration', () => {
    it('a real submitted job is configured with attempts=5 and exponential backoff, delay=2000ms — inspected directly, no waiting', async () => {
      const res = await submit(addressPayload({ employeeId: employeeId('job-config') })).expect(
        202,
      );
      const eventId = res.body.id as string;

      const job = await queue.getJob(eventId);
      expect(job).toBeDefined();
      expect(job?.opts.attempts).toBe(PAYROLL_EVENTS_JOB_ATTEMPTS);
      expect(job?.opts.attempts).toBe(5);
      expect(job?.opts.backoff).toEqual({
        type: 'exponential',
        delay: PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS,
      });
      expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
    });
  });

  describe('B/C/D. Full retry cycle through real BullMQ redelivery, to exhaustion', () => {
    it('a transient-failing event retries through attempts 1-4, then exhausts to FAILED/RETRYABLE on attempt 5 — no sixth retry', async () => {
      const event = await seedEvent({
        employeeId: `${employeeId('exhaust')}-${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}`,
      });

      // Short, matching-attempts override so the full 5-attempt cycle finishes in well under
      // a second — NOT the production defaultJobOptions (verified separately above).
      await queue.add(
        PROCESS_PAYROLL_EVENT_JOB_NAME,
        { eventId: event.id },
        { jobId: event.id, attempts: 5, backoff: { type: 'exponential', delay: 20 } },
      );

      await waitUntil(async () => {
        const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        return e.status === 'FAILED';
      });

      const finalEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(finalEvent.status).toBe('FAILED');
      expect(finalEvent.failureType).toBe('RETRYABLE');
      expect(finalEvent.attempts).toBe(5);
      expect(finalEvent.result).toBeNull();
      expect(finalEvent.failureReason).not.toBeNull();
      expect(finalEvent.processingFinishedAt).not.toBeNull();

      const history = await prisma.eventStatusHistory.findMany({
        where: { eventId: event.id },
        orderBy: { occurredAt: 'asc' },
      });
      // 5 claims (PENDING->PROCESSING), 4 retries (PROCESSING->PENDING), 1 final failure
      // (PROCESSING->FAILED) = 10 rows, each attemptNumber matching the claim it belongs to.
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'PENDING->PROCESSING',
        'PROCESSING->PENDING',
        'PENDING->PROCESSING',
        'PROCESSING->PENDING',
        'PENDING->PROCESSING',
        'PROCESSING->PENDING',
        'PENDING->PROCESSING',
        'PROCESSING->PENDING',
        'PENDING->PROCESSING',
        'PROCESSING->FAILED',
      ]);
      expect(history.map((h) => h.attemptNumber)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);

      // No sixth retry: attempts stays at 5 and status stays FAILED after settling a bit
      // longer than the last backoff delay would have taken.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settled = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(settled.attempts).toBe(5);
      expect(settled.status).toBe('FAILED');
      const historyAfterSettling = await prisma.eventStatusHistory.count({
        where: { eventId: event.id },
      });
      expect(historyAfterSettling).toBe(10);
    });
  });

  describe('E. Permanent failure — unaffected by R2 (regression, real infra)', () => {
    it('a permanent-failing event still fails on the first attempt with no retry transition', async () => {
      const res = await submit(
        addressPayload({ employeeId: `${employeeId('permanent')}-FORCE_PROVIDER_FAILURE` }),
      ).expect(202);
      const eventId = res.body.id as string;

      await waitUntil(async () => {
        const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        return e.status === 'FAILED';
      });

      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.failureType).toBe('PERMANENT');
      expect(event.attempts).toBe(1); // one claim, no retry

      const history = await prisma.eventStatusHistory.findMany({
        where: { eventId, NOT: { fromStatus: null } },
        orderBy: { occurredAt: 'asc' },
      });
      // Exactly the claim + the terminal failure — no PROCESSING->PENDING retry row anywhere.
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'PENDING->PROCESSING',
        'PROCESSING->FAILED',
      ]);
    });
  });

  describe('F. Success — unaffected by R2 (regression, real infra)', () => {
    it('a normal event still succeeds on the first attempt with no retry transition', async () => {
      const res = await submit(addressPayload({ employeeId: employeeId('success') })).expect(202);
      const eventId = res.body.id as string;

      await waitUntil(async () => {
        const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        return e.status === 'SUCCEEDED';
      });

      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.attempts).toBe(1);

      const history = await prisma.eventStatusHistory.findMany({
        where: { eventId, fromStatus: 'PROCESSING' },
      });
      expect(history).toHaveLength(1);
      expect(history[0].toStatus).toBe('SUCCEEDED');
    });
  });

  describe('G. Duplicate/terminal safety involving the new PENDING-via-retry sub-state', () => {
    it('a duplicate job for an event already FAILED/RETRYABLE (post-exhaustion) is a safe no-op: provider not called', async () => {
      const event = await seedEvent({
        status: 'FAILED',
        attempts: 5,
        failureType: 'RETRYABLE',
        failureReason: 'exhausted',
        processingFinishedAt: new Date(),
      });
      const spyProvider = new CountingProvider(new SimulatedPayrollProvider());
      const service = new EventProcessingService(prisma, spyProvider);

      const result = await service.processEvent(event.id);

      expect(result.outcome).toBe('terminal');
      expect(spyProvider.calls).toBe(0);

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FAILED');
      expect(after.attempts).toBe(5); // unchanged
    });

    it('two concurrent attempts on the same PENDING event, both destined to fail transiently: exactly one retry transition, provider invoked once', async () => {
      const event = await seedEvent({
        employeeId: `${employeeId('concurrent-retry')}-${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}`,
      });

      const prismaA = new PrismaService();
      const prismaB = new PrismaService();
      await prismaA.$connect();
      await prismaB.$connect();
      const spyProvider = new CountingProvider(new SimulatedPayrollProvider());
      const serviceA = new EventProcessingService(prismaA, spyProvider);
      const serviceB = new EventProcessingService(prismaB, spyProvider);

      try {
        const [resultA, resultB] = await Promise.all([
          serviceA.processEvent(event.id),
          serviceB.processEvent(event.id),
        ]);

        const outcomes = [resultA.outcome, resultB.outcome].sort();
        expect(outcomes).toEqual(['lost-race', 'retry-scheduled']);
        expect(spyProvider.calls).toBe(1); // the losing call never reaches the provider

        const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(after.status).toBe('PENDING'); // returned to PENDING, not terminal
        expect(after.attempts).toBe(1); // incremented exactly once, not twice

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { occurredAt: 'asc' },
        });
        expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
          'PENDING->PROCESSING',
          'PROCESSING->PENDING',
        ]);
      } finally {
        await prismaA.$disconnect();
        await prismaB.$disconnect();
      }
    });
  });
});
