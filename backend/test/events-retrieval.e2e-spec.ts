import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Retrieval endpoints (GET /events/:id, GET /events) — docs/assignment.md §2, architecture.md
 * §6. Events are always PENDING at this phase (queue/worker processing lands later); these
 * tests verify what's actually persisted is what comes back, not any processing outcome.
 */
describe('Event retrieval (GET /events/:id, GET /events)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const runPrefix = `ret-test-${randomUUID()}`;
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

  const submit = (payload: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', idempotencyKey())
      .send(payload);

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
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('GET /events/:id', () => {
    it('returns the persisted event with PENDING status and its status history', async () => {
      const emp = employeeId('detail');
      const created = await submit(addressPayload({ employeeId: emp })).expect(202);

      const res = await request(app.getHttpServer()).get(`/events/${created.body.id}`).expect(200);

      expect(res.body.id).toBe(created.body.id);
      expect(res.body.employeeId).toBe(emp);
      expect(res.body.eventType).toBe('ADDRESS_CHANGE');
      expect(res.body.status).toBe('PENDING');
      expect(res.body.sequence).toBe(created.body.sequence);
      expect(res.body.idempotencyKey).toBe(created.body.idempotencyKey);
      expect(res.body.payload.city).toBe('Berlin');
      expect(res.body.result).toBeNull();
      expect(res.body.failureReason).toBeNull();
      expect(res.body.failureType).toBeNull();

      expect(Array.isArray(res.body.statusHistory)).toBe(true);
      expect(res.body.statusHistory).toHaveLength(1);
      expect(res.body.statusHistory[0].fromStatus).toBeNull();
      expect(res.body.statusHistory[0].toStatus).toBe('PENDING');
    });

    it('returns 404 for a well-formed but non-existent id', async () => {
      await request(app.getHttpServer()).get(`/events/${randomUUID()}`).expect(404);
    });

    it('returns 404 (not 500) for a malformed id', async () => {
      await request(app.getHttpServer()).get('/events/not-a-uuid').expect(404);
    });
  });

  describe('GET /events', () => {
    it('lists a newly submitted PENDING event', async () => {
      const emp = employeeId('list-visible');
      const created = await submit(addressPayload({ employeeId: emp })).expect(202);

      const res = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp })
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe(created.body.id);
      expect(res.body.items[0].status).toBe('PENDING');
      expect(res.body.total).toBe(1);
      // Summary items don't carry the per-event status history (that's the :id detail view).
      expect(res.body.items[0].statusHistory).toBeUndefined();
    });

    it('filters by employeeId', async () => {
      const empA = employeeId('list-filter-a');
      const empB = employeeId('list-filter-b');
      await submit(addressPayload({ employeeId: empA })).expect(202);
      await submit(addressPayload({ employeeId: empB })).expect(202);

      const res = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: empA })
        .expect(200);

      expect(res.body.items.every((e: { employeeId: string }) => e.employeeId === empA)).toBe(true);
    });

    it('filters by status', async () => {
      const emp = employeeId('list-status');
      await submit(addressPayload({ employeeId: emp })).expect(202);

      const pending = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp, status: 'PENDING' })
        .expect(200);
      expect(pending.body.items.length).toBeGreaterThan(0);

      const failed = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp, status: 'FAILED' })
        .expect(200);
      expect(failed.body.items).toHaveLength(0);
    });

    it('applies a bounded default limit and respects an explicit limit/offset', async () => {
      const emp = employeeId('list-paging');
      for (let i = 0; i < 5; i++) {
        await submit(addressPayload({ employeeId: emp, street: `Street ${i}` })).expect(202);
      }

      const page1 = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp, limit: 2, offset: 0 })
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(5);
      expect(page1.body.limit).toBe(2);
      expect(page1.body.offset).toBe(0);

      const page2 = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp, limit: 2, offset: 2 })
        .expect(200);
      expect(page2.body.items).toHaveLength(2);
      expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
    });

    it('response items are shaped consistently with POST /events', async () => {
      const emp = employeeId('list-shape');
      const created = await submit(addressPayload({ employeeId: emp })).expect(202);

      const res = await request(app.getHttpServer())
        .get('/events')
        .query({ employeeId: emp })
        .expect(200);

      expect(Object.keys(res.body.items[0]).sort()).toEqual(Object.keys(created.body).sort());
    });
  });
});
