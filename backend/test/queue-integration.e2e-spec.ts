import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PayrollEventsQueueService } from '../src/processing/payroll-events-queue.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PROCESS_PAYROLL_EVENT_JOB_NAME,
} from '../src/processing/processing.constants';

/**
 * Queue integration (this phase) — docs/architecture.md §9/§15/§17, this phase's own spec.
 * Runs against real PostgreSQL AND real Redis/BullMQ (see backend/.env / docker-compose.yml)
 * — job creation, jobId, and payload shape are specifically not trustworthy to assert
 * against a mocked queue, since the whole point is that the real thing behaves this way.
 */
describe('Queue integration (POST /events → BullMQ)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let queueService: PayrollEventsQueueService;

  const runPrefix = `queue-test-${randomUUID()}`;
  const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;
  const idempotencyKey = () => `${runPrefix}-idem-${randomUUID()}`;

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

  const submit = (payload: Record<string, unknown>, key = idempotencyKey()) =>
    request(app.getHttpServer()).post('/events').set('Idempotency-Key', key).send(payload);

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
    queue = app.get(PAYROLL_EVENTS_QUEUE);
    queueService = app.get(PayrollEventsQueueService);
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('GET /health', () => {
    it('reports both PostgreSQL and Redis as up', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        dependencies: { postgres: 'up', redis: 'up' },
      });
    });
  });

  describe('job creation', () => {
    it('creates exactly one BullMQ job whose id and data.eventId equal the event id', async () => {
      const res = await submit(addressPayload({ employeeId: employeeId('job-shape') })).expect(202);
      const eventId = res.body.id as string;

      const job = await queue.getJob(eventId);
      expect(job).toBeDefined();
      expect(job?.id).toBe(eventId);
      expect(job?.name).toBe(PROCESS_PAYROLL_EVENT_JOB_NAME);
      expect(job?.data).toEqual({ eventId });

      // Confirmed independently: the event is genuinely PENDING (no processing yet).
      const dbEvent = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(dbEvent.status).toBe('PENDING');
    });
  });

  describe('duplicate submission', () => {
    it('does not create a second job when the same idempotent request is repeated', async () => {
      const key = idempotencyKey();
      const payload = addressPayload({ employeeId: employeeId('dup-http') });

      const first = await submit(payload, key).expect(202);
      const second = await submit(payload, key).expect(202);
      expect(second.body.id).toBe(first.body.id);

      const job = await queue.getJob(first.body.id);
      expect(job).toBeDefined();
      expect(job?.id).toBe(first.body.id);
    });

    it('BullMQ itself treats a repeated enqueue for the same eventId as a no-op, not a second job', async () => {
      const eventId = randomUUID(); // no DB row needed — this exercises the queue layer alone
      await queueService.enqueue(eventId);
      await queueService.enqueue(eventId); // must not throw

      const job = await queue.getJob(eventId);
      expect(job).toBeDefined();
      expect(job?.id).toBe(eventId);

      await queue.remove(eventId); // cleanup — this job has no corresponding DB row
    });
  });

  describe('transaction boundary', () => {
    it('the event is visible to an independent connection before enqueue is invoked', async () => {
      const independentPrisma = new PrismaService();
      await independentPrisma.$connect();

      const originalEnqueue = PayrollEventsQueueService.prototype.enqueue;
      const observedAsCommitted: boolean[] = [];
      const enqueueSpy = jest
        .spyOn(PayrollEventsQueueService.prototype, 'enqueue')
        .mockImplementation(async function (this: PayrollEventsQueueService, eventId: string) {
          // At the moment enqueue is called, a transaction that had merely started the
          // event's insert (not yet committed) would be invisible to this *separate*
          // connection under Postgres's READ COMMITTED isolation — so finding it here proves
          // the insert had already committed by the time enqueue ran, not just that the code
          // happens to be written in the right order.
          const row = await independentPrisma.payrollEvent.findUnique({ where: { id: eventId } });
          observedAsCommitted.push(row !== null);
          // Call through to the real implementation so this test still produces a real job.
          return originalEnqueue.call(this, eventId);
        });

      try {
        const res = await submit(addressPayload({ employeeId: employeeId('tx-boundary') })).expect(
          202,
        );
        expect(observedAsCommitted).toEqual([true]);
        expect(res.body.status).toBe('PENDING');
      } finally {
        enqueueSpy.mockRestore();
        await independentPrisma.$disconnect();
      }
    });
  });
});
