import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Job, Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  PROCESS_PAYROLL_EVENT_JOB_NAME,
  REDIS_CONNECTION,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { createFailedJobBackstopHandler } from '../src/processing/payroll-event-failed-backstop';
import { EventProcessingService } from '../src/processing/event-processing.service';
import {
  FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER,
  SimulatedPayrollProvider,
} from '../src/processing/simulated-payroll-provider';

/**
 * Retry/backoff design, R3 — BullMQ Worker `failed` event backstop. Runs against real
 * PostgreSQL AND real Redis/BullMQ.
 *
 * The actual gap this backstop targets (a job BullMQ considers exhausted while its event is
 * still `PROCESSING` in Postgres) cannot be produced by the normal, well-behaved processor —
 * R2's own attempts-vs-maxAttempts check always finalizes before the processor would ever let
 * such a job exhaust. To exercise the backstop with real BullMQ mechanics (real
 * `job.attemptsMade`/`job.opts.attempts`, a real `'failed'` emission), these tests use a
 * temporary `Worker` on the SAME real queue with a deliberately misbehaving processor that
 * throws unconditionally — standing in for "the normal path never got to finalize" — with the
 * real backstop handler wired to its `'failed'` event. This is not a new production queue or
 * worker; it is a test-only stand-in for a crash/bug in the normal path, consuming the one
 * approved `payroll-events` queue.
 *
 * IMPORTANT: only ONE worker is ever connected to the queue within a given test in this file.
 * Two independent workers racing for the same job is a real, non-deterministic hazard (BullMQ
 * does not let a caller pin a job to a specific worker instance) — each `describe` block below
 * builds and tears down its own worker(s) rather than sharing one across the whole file.
 */
describe('Retry/backoff R3: BullMQ failed-event backstop', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let queue: Queue;
  let eventProcessingService: EventProcessingService;

  const runPrefix = `backstop-test-${randomUUID()}`;
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

  /** A deliberately misbehaving processor: throws unconditionally, never calls EventProcessingService. */
  const alwaysThrowProcessor = async (job: Job<{ eventId?: unknown }>): Promise<void> => {
    throw new Error(`simulated unexpected failure before finalize could run: jobId=${job.id}`);
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
    eventProcessingService = new EventProcessingService(prisma, new SimulatedPayrollProvider());
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('the actual backstop gap: PROCESSING + BullMQ-exhausted job never reconciled by the normal path', () => {
    it('finalizes a stuck PROCESSING event to FAILED/RETRYABLE once its job is exhausted, and is idempotent on a second exhausted delivery', async () => {
      const event = await seedEvent({ status: 'PROCESSING', attempts: 3, maxAttempts: 5 });

      // The ONLY worker connected to the queue for the duration of this test — stands in for
      // "an unexpected error left this event stuck in PROCESSING." attempts: 1 means this
      // single failure is immediately exhausted (deterministic, no waiting on retries).
      const misbehavingWorker = new Worker(PAYROLL_EVENTS_QUEUE_NAME, alwaysThrowProcessor, {
        connection: redis,
      });
      misbehavingWorker.on('failed', createFailedJobBackstopHandler(eventProcessingService));
      await misbehavingWorker.waitUntilReady();

      try {
        await queue.add(
          PROCESS_PAYROLL_EVENT_JOB_NAME,
          { eventId: event.id },
          { jobId: event.id, attempts: 1 },
        );

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'FAILED';
        });

        const finalized = await prisma.payrollEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(finalized.status).toBe('FAILED');
        expect(finalized.failureType).toBe('RETRYABLE');
        expect(finalized.attempts).toBe(3); // unchanged — the backstop never touches attempts
        expect(finalized.result).toBeNull();
        expect(finalized.failureReason).not.toBeNull();
        expect(finalized.failureReason).not.toContain('simulated unexpected failure'); // no raw error leaked

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
        });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          fromStatus: 'PROCESSING',
          toStatus: 'FAILED',
          attemptNumber: 3,
        });

        // Trigger the listener again: a second exhausted delivery for the same eventId (the
        // event is now FAILED) must be a safe no-op — no duplicate history, no mutation.
        await queue.add(
          PROCESS_PAYROLL_EVENT_JOB_NAME,
          { eventId: event.id },
          { jobId: `${event.id}-redelivery`, attempts: 1 },
        );

        await waitUntil(async () => {
          const job = await queue.getJob(`${event.id}-redelivery`);
          return job === undefined || (await job.isFailed());
        });
        // Give the second backstop invocation a moment to run and (correctly) do nothing.
        await new Promise((resolve) => setTimeout(resolve, 200));

        const afterSecondDelivery = await prisma.payrollEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(afterSecondDelivery.status).toBe('FAILED');
        expect(afterSecondDelivery.attempts).toBe(3);

        const historyAfter = await prisma.eventStatusHistory.count({
          where: { eventId: event.id },
        });
        expect(historyAfter).toBe(1); // still exactly one — no duplicate
      } finally {
        await misbehavingWorker.close();
      }
    });

    it('does NOT finalize while BullMQ retries remain for the (misbehaving) job', async () => {
      const event = await seedEvent({ status: 'PROCESSING', attempts: 1, maxAttempts: 5 });

      const misbehavingWorker = new Worker(PAYROLL_EVENTS_QUEUE_NAME, alwaysThrowProcessor, {
        connection: redis,
      });
      let failedCount = 0;
      misbehavingWorker.on('failed', () => {
        failedCount += 1;
      });
      misbehavingWorker.on('failed', createFailedJobBackstopHandler(eventProcessingService));
      await misbehavingWorker.waitUntilReady();

      try {
        // attempts: 2, short fixed backoff — the first failure must NOT finalize (one retry
        // still remains); only the second, truly exhausted failure should.
        await queue.add(
          PROCESS_PAYROLL_EVENT_JOB_NAME,
          { eventId: event.id },
          { jobId: event.id, attempts: 2, backoff: { type: 'fixed', delay: 100 } },
        );

        // Wait for exactly the first failure to be observed.
        await waitUntil(async () => failedCount >= 1);
        // The event must still be PROCESSING immediately after the first (non-exhausted) failure.
        const afterFirstFailure = await prisma.payrollEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(afterFirstFailure.status).toBe('PROCESSING');

        // Now wait for the second (exhausted) failure to actually finalize it.
        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'FAILED';
        });
        const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(final.failureType).toBe('RETRYABLE');

        const history = await prisma.eventStatusHistory.count({ where: { eventId: event.id } });
        expect(history).toBe(1); // only the final exhaustion produced a row
      } finally {
        await misbehavingWorker.close();
      }
    });
  });

  describe('normal R2 exhaustion is unaffected: no duplicate finalization from the backstop', () => {
    it('a transient-failing event exhausting through the normal path produces exactly one terminal history row, not two', async () => {
      // The ONLY worker connected to the queue for the duration of this test — the real,
      // production-shaped worker (real processor, real provider, both 'failed' listeners
      // attached, mirroring WorkerProcessingModule's own wiring exactly).
      const realWorker = new Worker(
        PAYROLL_EVENTS_QUEUE_NAME,
        createPayrollEventProcessor(eventProcessingService),
        { connection: redis, concurrency: 5 },
      );
      realWorker.on('failed', createFailedJobBackstopHandler(eventProcessingService));
      await realWorker.waitUntilReady();

      try {
        const event = await seedEvent({
          employeeId: `${employeeId('normal-exhaust')}-${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}`,
        });

        // Short, matching-attempts override so the cycle finishes fast — same technique as
        // R2's own exhaustion test.
        await queue.add(
          PROCESS_PAYROLL_EVENT_JOB_NAME,
          { eventId: event.id },
          { jobId: event.id, attempts: 5, backoff: { type: 'exponential', delay: 20 } },
        );

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'FAILED';
        });

        // Give any (incorrect, hypothetical) extra backstop write a moment to have happened.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const final = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
        expect(final.status).toBe('FAILED');
        expect(final.failureType).toBe('RETRYABLE');
        expect(final.attempts).toBe(5);

        const history = await prisma.eventStatusHistory.findMany({
          where: { eventId: event.id },
          orderBy: { occurredAt: 'asc' },
        });
        // Exactly the R2 shape: 5 claims + 4 retries + 1 final failure = 10 rows, not 11 — the
        // backstop's 'failed' listener never even fires here because the normal processor
        // returns without throwing on the exhausting attempt (R2 behavior, unchanged).
        expect(history).toHaveLength(10);
        expect(history.filter((h) => h.toStatus === 'FAILED')).toHaveLength(1);
      } finally {
        await realWorker.close();
      }
    });

    it('POST /events end-to-end (real API + real worker) still succeeds normally with the backstop listener attached', async () => {
      const realWorker = new Worker(
        PAYROLL_EVENTS_QUEUE_NAME,
        createPayrollEventProcessor(eventProcessingService),
        { connection: redis, concurrency: 5 },
      );
      realWorker.on('failed', createFailedJobBackstopHandler(eventProcessingService));
      await realWorker.waitUntilReady();

      try {
        const res = await submit(
          addressPayload({ employeeId: employeeId('normal-success') }),
        ).expect(202);
        const eventId = res.body.id as string;

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
          return e.status === 'SUCCEEDED';
        });

        const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        expect(event.attempts).toBe(1);
      } finally {
        await realWorker.close();
      }
    });
  });
});
