import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Worker } from 'bullmq';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  PAYROLL_EVENTS_QUEUE_NAME,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { EventProcessingService } from '../src/processing/event-processing.service';
import type Redis from 'ioredis';

/**
 * Worker foundation + PENDING -> PROCESSING (this phase). Runs against real PostgreSQL AND
 * real Redis/BullMQ — the whole point of this phase is a concurrency-correct, atomic
 * transition, which a mocked Prisma client cannot demonstrate.
 *
 * The test worker below is a genuine `bullmq.Worker` consuming the real `payroll-events`
 * queue (same queue name constant the API's producer uses) — not a direct call into
 * EventProcessingService pretending to be "the worker". `EventsModule`'s AppModule bootstrap
 * (via ProcessingModule) supplies the producer side (POST /events -> real job); this file's
 * own Worker instance supplies the consumer side, deliberately built the same way
 * WorkerProcessingModule builds it in worker.ts, so this test exercises the real integration
 * path end to end: POST /events -> PostgreSQL PENDING -> BullMQ job -> real worker consumes
 * -> PostgreSQL PROCESSING -> status history contains the transition.
 */
describe('Worker: PENDING -> PROCESSING', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let worker: Worker;
  let eventProcessingService: EventProcessingService;

  const runPrefix = `worker-test-${randomUUID()}`;
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

  // Seeds a payroll_events row directly (bypassing the API) so terminal-state / missing-event
  // scenarios can be set up precisely, without depending on a real provider that doesn't
  // exist yet in this phase.
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

  // Polls until the predicate is true or the timeout elapses — the worker consumes jobs
  // asynchronously, so tests must wait for that to happen rather than asserting immediately.
  const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 5000) => {
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
    eventProcessingService = new EventProcessingService(prisma);

    // A real BullMQ Worker, built the same way WorkerProcessingModule builds one in
    // worker.ts, consuming the same real queue the API just enqueued a job onto.
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

  it('a real worker consumes a real job produced by POST /events: PENDING -> PROCESSING, with history', async () => {
    const res = await submit(addressPayload({ employeeId: employeeId('pickup') })).expect(202);
    const eventId = res.body.id as string;

    const dbEventBefore = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(dbEventBefore.status).toBe('PENDING');

    await waitUntil(async () => {
      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      return event.status === 'PROCESSING';
    });

    const dbEventAfter = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(dbEventAfter.status).toBe('PROCESSING');
    expect(dbEventAfter.attempts).toBe(1);
    expect(dbEventAfter.processingStartedAt).not.toBeNull();

    // Submission itself already wrote a (null -> PENDING) history row (established in the
    // event-submission phase); this test is only concerned with the transition the worker
    // adds on top of that.
    const history = await prisma.eventStatusHistory.findMany({
      where: { eventId, fromStatus: 'PENDING', toStatus: 'PROCESSING' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'PROCESSING',
      attemptNumber: 1,
    });
  });

  it.each(['SUCCEEDED', 'FAILED'])(
    'terminal state (%s) is a safe no-op: status unchanged, no new history, no transition',
    async (status) => {
      const event = await seedEvent({ status, attempts: 1 });

      const result = await eventProcessingService.processEvent(event.id);
      expect(result.outcome).toBe('terminal');

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe(status);
      expect(after.attempts).toBe(1);

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(0);
    },
  );

  it('concurrent processing: two independent processing attempts on the same PENDING event yield exactly one PROCESSING transition', async () => {
    const event = await seedEvent();

    // Two separate PrismaService connections, each with its own EventProcessingService,
    // simulating two independent worker processes racing to claim the same event — a single
    // shared client typically serializes its own statements sequentially, which would be a
    // weaker test of genuine concurrent database access.
    const prismaA = new PrismaService();
    const prismaB = new PrismaService();
    await prismaA.$connect();
    await prismaB.$connect();
    const serviceA = new EventProcessingService(prismaA);
    const serviceB = new EventProcessingService(prismaB);

    try {
      const [resultA, resultB] = await Promise.all([
        serviceA.processEvent(event.id),
        serviceB.processEvent(event.id),
      ]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(['claimed', 'lost-race']);

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('PROCESSING');
      expect(after.attempts).toBe(1); // incremented exactly once, not twice

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: event.id } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ fromStatus: 'PENDING', toStatus: 'PROCESSING' });
    } finally {
      await prismaA.$disconnect();
      await prismaB.$disconnect();
    }
  });

  it('missing event: a job for a nonexistent eventId does not crash the worker and processes as a safe no-op', async () => {
    const nonexistentEventId = randomUUID();
    const result = await eventProcessingService.processEvent(nonexistentEventId);
    expect(result).toEqual({ outcome: 'missing' });

    // The worker must still be alive and able to process a subsequent, legitimate job.
    const res = await submit(addressPayload({ employeeId: employeeId('after-missing') })).expect(
      202,
    );
    const eventId = res.body.id as string;

    await waitUntil(async () => {
      const dbEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      return dbEvent.status === 'PROCESSING';
    });

    const dbEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(dbEvent.status).toBe('PROCESSING');
  });

  it('a job whose data has no eventId fails cleanly without crashing the worker or affecting other jobs', async () => {
    const queue = app.get(REDIS_CONNECTION); // sanity: shared connection is up
    expect(queue).toBeDefined();

    let failedEvent: { jobId: string | undefined } | undefined;
    const onFailed = (job: { id?: string } | undefined) => {
      failedEvent = { jobId: job?.id };
    };
    worker.on('failed', onFailed);

    try {
      // Enqueue directly onto the raw queue with a malformed payload — bypassing
      // PayrollEventsQueueService, which always sends a well-formed { eventId } shape.
      const malformedJobId = `malformed-${randomUUID()}`;
      const { Queue } = await import('bullmq');
      const rawQueue = new Queue(PAYROLL_EVENTS_QUEUE_NAME, { connection: redis });
      await rawQueue.add(
        'process-payroll-event',
        { notAnEventId: true },
        { jobId: malformedJobId },
      );
      await rawQueue.close();

      await waitUntil(async () => failedEvent?.jobId === malformedJobId);

      // The worker survives and still processes a subsequent legitimate job.
      const res = await submit(
        addressPayload({ employeeId: employeeId('after-malformed') }),
      ).expect(202);
      const eventId = res.body.id as string;
      await waitUntil(async () => {
        const dbEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
        return dbEvent.status === 'PROCESSING';
      });
    } finally {
      worker.off('failed', onFailed);
    }
  });
});
