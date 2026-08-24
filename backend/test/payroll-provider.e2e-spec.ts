import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  PAYROLL_EVENTS_QUEUE_NAME,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { EventProcessingService } from '../src/processing/event-processing.service';
import {
  FORCE_PROVIDER_FAILURE_MARKER,
  SimulatedPayrollProvider,
} from '../src/processing/simulated-payroll-provider';
import type {
  PayrollProvider,
  PayrollProviderInput,
  PayrollProviderOutcome,
} from '../src/processing/payroll-provider';

/**
 * Payroll provider simulation + processing outcome (this phase). Extends the worker
 * foundation's PENDING -> PROCESSING transition with:
 *
 *   PROCESSING -> SUCCEEDED (provider succeeds)
 *   PROCESSING -> FAILED    (provider fails)
 *
 * Runs against real PostgreSQL AND real Redis/BullMQ, using the actual
 * SimulatedPayrollProvider implementation (not a mock) for the two "real worker" scenarios
 * (§13 of this phase's spec) — a genuine `bullmq.Worker`, built the same way
 * WorkerProcessingModule builds it, consumes a genuine job produced by a real POST /events.
 *
 * The duplicate-processing-safety and concurrency scenarios (§10) call
 * EventProcessingService directly against real Postgres, the same technique the worker-
 * processing phase established for testing the CAS claim in isolation — here with a
 * call-counting provider wrapper so "the provider was invoked at most once" can be asserted
 * precisely, which a real end-to-end BullMQ run cannot easily observe.
 */
describe('Payroll provider simulation + processing outcome', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let worker: Worker;
  let eventProcessingService: EventProcessingService;

  const runPrefix = `provider-test-${randomUUID()}`;
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

  const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 5000) => {
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

  describe('success flow (real worker, real Postgres, real Redis)', () => {
    it('POST /events -> PENDING -> BullMQ -> real worker -> PROCESSING -> provider SUCCESS -> SUCCEEDED', async () => {
      const res = await submit(addressPayload({ employeeId: employeeId('success') })).expect(202);
      const eventId = res.body.id as string;

      await waitUntil(async () => {
        const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        return event.status === 'SUCCEEDED';
      });

      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.status).toBe('SUCCEEDED');
      expect(event.result).not.toBeNull();
      expect(event.failureReason).toBeNull();
      expect(event.failureType).toBeNull();
      expect(event.processingFinishedAt).not.toBeNull();

      const history = await prisma.eventStatusHistory.findMany({
        where: { eventId, NOT: { fromStatus: null } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'PENDING->PROCESSING',
        'PROCESSING->SUCCEEDED',
      ]);
    });
  });

  describe('failure flow (real worker, real Postgres, real Redis)', () => {
    it('POST /events -> PENDING -> BullMQ -> real worker -> PROCESSING -> provider FAILURE -> FAILED', async () => {
      const res = await submit(
        addressPayload({
          employeeId: `${employeeId('failure')}-${FORCE_PROVIDER_FAILURE_MARKER}`,
        }),
      ).expect(202);
      const eventId = res.body.id as string;

      await waitUntil(async () => {
        const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        return event.status === 'FAILED';
      });

      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.status).toBe('FAILED');
      expect(event.result).toBeNull();
      expect(event.failureReason).not.toBeNull();
      expect(event.failureType).toBe('PERMANENT');
      expect(event.processingFinishedAt).not.toBeNull();

      const history = await prisma.eventStatusHistory.findMany({
        where: { eventId, NOT: { fromStatus: null } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'PENDING->PROCESSING',
        'PROCESSING->FAILED',
      ]);
      expect(history[1].errorMessage).toBe(event.failureReason);
    });
  });

  describe('duplicate-processing safety', () => {
    it('Case A: a SUCCEEDED event receiving a duplicate job never calls the provider', async () => {
      const event = await seedEvent({
        status: 'SUCCEEDED',
        attempts: 1,
        result: { providerReference: 'sim-already-done' },
        processingFinishedAt: new Date(),
      });
      const spyProvider = new CountingProvider(new SimulatedPayrollProvider());
      const service = new EventProcessingService(prisma, spyProvider);

      const result = await service.processEvent(event.id);

      expect(result.outcome).toBe('terminal');
      expect(spyProvider.calls).toBe(0);

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('SUCCEEDED');
      expect(after.result).toEqual({ providerReference: 'sim-already-done' });

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(0); // seedEvent bypasses the API, so no history exists at all
    });

    it('Case B: a FAILED event receiving a duplicate job never calls the provider', async () => {
      const event = await seedEvent({
        status: 'FAILED',
        attempts: 1,
        failureReason: 'original failure',
        failureType: 'PERMANENT',
        processingFinishedAt: new Date(),
      });
      const spyProvider = new CountingProvider(new SimulatedPayrollProvider());
      const service = new EventProcessingService(prisma, spyProvider);

      const result = await service.processEvent(event.id);

      expect(result.outcome).toBe('terminal');
      expect(spyProvider.calls).toBe(0);

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FAILED');
      expect(after.failureReason).toBe('original failure');

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(0);
    });
  });

  describe('concurrent processing (Case C)', () => {
    it('two concurrent attempts on the same PENDING event: exactly one PROCESSING claim, provider invoked once, exactly one final transition', async () => {
      const event = await seedEvent();

      // Two separate PrismaService connections, each with its own EventProcessingService, but
      // sharing ONE counting provider instance — simulating two independent worker processes
      // racing to claim the same event while still being able to observe the total number of
      // provider invocations across both.
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
        expect(outcomes).toEqual(['lost-race', 'succeeded']);
        expect(spyProvider.calls).toBe(1); // never invoked twice, regardless of the race

        const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(after.status).toBe('SUCCEEDED');
        expect(after.attempts).toBe(1); // incremented exactly once, not twice

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { occurredAt: 'asc' },
        });
        expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
          'PENDING->PROCESSING',
          'PROCESSING->SUCCEEDED',
        ]);
      } finally {
        await prismaA.$disconnect();
        await prismaB.$disconnect();
      }
    });
  });
});
