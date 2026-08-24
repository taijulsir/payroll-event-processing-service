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
import { SimulatedPayrollProvider } from '../src/processing/simulated-payroll-provider';
import type Redis from 'ioredis';

/**
 * Worker foundation + full lifecycle (worker-processing phase, extended by the
 * payroll-provider phase). Runs against real PostgreSQL AND real Redis/BullMQ — the whole
 * point of these phases is a concurrency-correct, atomic transition, which a mocked Prisma
 * client cannot demonstrate.
 *
 * The test worker below is a genuine `bullmq.Worker` consuming the real `payroll-events`
 * queue (same queue name constant the API's producer uses) — not a direct call into
 * EventProcessingService pretending to be "the worker". `EventsModule`'s AppModule bootstrap
 * (via ProcessingModule) supplies the producer side (POST /events -> real job); this file's
 * own Worker instance supplies the consumer side, deliberately built the same way
 * WorkerProcessingModule builds it in worker.ts (including the real SimulatedPayrollProvider,
 * not a mock), so this test exercises the real integration path end to end. Since a normal
 * event now runs all the way to a terminal state automatically (this phase's addition), these
 * tests wait for SUCCEEDED, not PROCESSING — the deeper, provider-specific
 * success/failure/duplicate/concurrency scenarios live in test/payroll-provider.e2e-spec.ts;
 * this file keeps its original focus on worker pickup and error isolation.
 */
describe('Worker: PENDING -> PROCESSING -> SUCCEEDED', () => {
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
    eventProcessingService = new EventProcessingService(prisma, new SimulatedPayrollProvider());

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

  it('a real worker consumes a real job produced by POST /events and runs the full lifecycle: PENDING -> PROCESSING -> SUCCEEDED, with history', async () => {
    const res = await submit(addressPayload({ employeeId: employeeId('pickup') })).expect(202);
    const eventId = res.body.id as string;

    // Deliberately not asserting the event is PENDING immediately after submit here: with the
    // real worker in this same process now running the full lifecycle with no artificial
    // delay, that read would race the worker and could observe PENDING, PROCESSING, or already
    // SUCCEEDED depending on scheduling — exactly the kind of timing-dependent assertion this
    // phase's tests must avoid. queue-integration.e2e-spec.ts's "job creation" test already
    // covers "the event is genuinely PENDING right after submission" in isolation, with no
    // worker running in that file to race against.
    //
    // A normal employeeId (no deterministic-failure marker) always succeeds, and the
    // simulated provider adds no artificial delay, so the worker runs claim -> provider ->
    // finalize to completion on its own; waiting for the terminal state (rather than for the
    // transient PROCESSING state) is what makes this assertion non-flaky.
    await waitUntil(async () => {
      const event = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      return event.status === 'SUCCEEDED';
    });

    const dbEventAfter = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(dbEventAfter.status).toBe('SUCCEEDED');
    expect(dbEventAfter.attempts).toBe(1);
    expect(dbEventAfter.processingStartedAt).not.toBeNull();
    expect(dbEventAfter.processingFinishedAt).not.toBeNull();
    expect(dbEventAfter.result).not.toBeNull();

    // Submission itself already wrote a (null -> PENDING) history row (established in the
    // event-submission phase); this test is only concerned with the transitions the worker
    // adds on top of that.
    const history = await prisma.eventStatusHistory.findMany({
      where: { eventId, NOT: { fromStatus: null } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'PROCESSING',
      attemptNumber: 1,
    });
    expect(history[1]).toMatchObject({
      fromStatus: 'PROCESSING',
      toStatus: 'SUCCEEDED',
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

  // The concurrent-processing race test (two independent EventProcessingService instances
  // attempting the same PENDING event) moved to test/payroll-provider.e2e-spec.ts, where it
  // now also asserts the provider is invoked exactly once — a strict superset of what this
  // file's original version checked, so it is not duplicated here.

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
      return dbEvent.status === 'SUCCEEDED';
    });

    const dbEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(dbEvent.status).toBe('SUCCEEDED');
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
        return dbEvent.status === 'SUCCEEDED';
      });
    } finally {
      worker.off('failed', onFailed);
    }
  });
});
