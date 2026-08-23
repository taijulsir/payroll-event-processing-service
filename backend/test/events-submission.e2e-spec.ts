import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Event submission workflow (POST /events) — docs/assignment.md §1/§5/§9/§11,
 * architecture.md §6/§10/§11/§12, database-design.md §7/§9/§10.
 *
 * Runs against a real PostgreSQL (see backend/.env / docker-compose.yml) — idempotency and
 * concurrency correctness are specifically NOT trustworthy to assert against a mock, since
 * the whole point is that a real UNIQUE constraint and a real advisory lock are what make
 * them safe.
 */
describe('POST /events (event submission)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Distinguishes this run's rows for cleanup, regardless of which assertions passed/failed.
  const runPrefix = `sub-test-${randomUUID()}`;
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

  describe('validation', () => {
    it('accepts a valid event and returns 202 with Location', async () => {
      const res = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: employeeId('valid') }))
        .expect(202);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('PENDING');
      expect(res.body.sequence).toBe('1');
      expect(res.headers.location).toBe(`/events/${res.body.id}`);
    });

    it('rejects a request with no Idempotency-Key header', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .send(addressPayload({ employeeId: employeeId('no-key') }))
        .expect(400);
    });

    it('rejects an unknown eventType', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send({ eventType: 'NOT_A_REAL_TYPE', employeeId: employeeId('bad-type') })
        .expect(400);
    });

    it('rejects a request missing a required field for its event type', async () => {
      const missingIban = {
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: employeeId('missing-iban'),
        effectiveDate: '2026-01-01',
        // iban intentionally omitted
      };
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(missingIban)
        .expect(400);
    });

    it('rejects a payload with an unknown extra field (whitelist)', async () => {
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: employeeId('extra-field'), notAField: 'x' }))
        .expect(400);
    });
  });

  describe('idempotency', () => {
    it('creates exactly one event for a fresh idempotency key', async () => {
      const key = idempotencyKey();
      const emp = employeeId('idem-first');
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(addressPayload({ employeeId: emp }))
        .expect(202);

      const rows = await prisma.payrollEvent.findMany({ where: { idempotencyKey: key } });
      expect(rows).toHaveLength(1);
    });

    it('returns the same event when the identical request is repeated', async () => {
      const key = idempotencyKey();
      const emp = employeeId('idem-repeat');
      const payload = addressPayload({ employeeId: emp });

      const first = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(202);

      const second = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(202);

      expect(second.body.id).toBe(first.body.id);

      const rows = await prisma.payrollEvent.findMany({ where: { idempotencyKey: key } });
      expect(rows).toHaveLength(1);
    });

    it('rejects reuse of the same key with a materially different payload (409)', async () => {
      const key = idempotencyKey();
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(addressPayload({ employeeId: employeeId('conflict-a') }))
        .expect(202);

      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(addressPayload({ employeeId: employeeId('conflict-b') })) // different employee
        .expect(409);
    });

    it('creates exactly one event under concurrent duplicate submissions', async () => {
      const key = idempotencyKey();
      const emp = employeeId('idem-concurrent');
      const payload = addressPayload({ employeeId: emp });

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app.getHttpServer()).post('/events').set('Idempotency-Key', key).send(payload),
        ),
      );

      for (const res of responses) {
        expect(res.status).toBe(202);
      }
      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);

      const rows = await prisma.payrollEvent.findMany({ where: { idempotencyKey: key } });
      expect(rows).toHaveLength(1);
    });
  });

  describe('per-employee sequence', () => {
    it('assigns sequence 1 to the first event and 2 to the second for the same employee', async () => {
      const emp = employeeId('seq-order');

      const first = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: emp }))
        .expect(202);
      expect(first.body.sequence).toBe('1');

      const second = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: emp, street: '2 Example Street' }))
        .expect(202);
      expect(second.body.sequence).toBe('2');
    });

    it('assigns unique, sequential sequence numbers under concurrent submissions for one employee', async () => {
      const emp = employeeId('seq-concurrent');
      const count = 10;

      const responses = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          request(app.getHttpServer())
            .post('/events')
            .set('Idempotency-Key', idempotencyKey())
            .send(addressPayload({ employeeId: emp, street: `Street ${i}` })),
        ),
      );

      for (const res of responses) {
        expect(res.status).toBe(202);
      }

      const sequences = responses.map((r) => Number(r.body.sequence)).sort((a, b) => a - b);
      expect(sequences).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    });

    it('lets two different employees submit independently, each starting at sequence 1', async () => {
      const empA = employeeId('seq-indep-a');
      const empB = employeeId('seq-indep-b');

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', idempotencyKey())
          .send(addressPayload({ employeeId: empA })),
        request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', idempotencyKey())
          .send(addressPayload({ employeeId: empB })),
      ]);

      expect(resA.status).toBe(202);
      expect(resB.status).toBe(202);
      expect(resA.body.sequence).toBe('1');
      expect(resB.body.sequence).toBe('1');
    });
  });

  describe('database state', () => {
    it('persists the event as PENDING with the submitted payload', async () => {
      const emp = employeeId('db-state');
      const res = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: emp }))
        .expect(202);

      const row = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.status).toBe('PENDING');
      expect(row.employeeId).toBe(emp);
      expect(row.eventType).toBe('ADDRESS_CHANGE');
      expect(row.attempts).toBe(0);
      expect(row.submittedAt).toBeInstanceOf(Date);
      expect((row.payload as Record<string, unknown>).city).toBe('Berlin');

      const history = await prisma.eventStatusHistory.findMany({ where: { eventId: row.id } });
      expect(history).toHaveLength(1);
      expect(history[0].toStatus).toBe('PENDING');
    });
  });

  describe('failure behavior', () => {
    it('does not create a row for a rejected (invalid) submission', async () => {
      const before = await prisma.payrollEvent.count({
        where: { employeeId: { startsWith: runPrefix } },
      });

      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send({ eventType: 'NOT_A_REAL_TYPE' })
        .expect(400);

      const after = await prisma.payrollEvent.count({
        where: { employeeId: { startsWith: runPrefix } },
      });
      expect(after).toBe(before);
    });

    it('does not create a second row for a rejected duplicate (409) submission', async () => {
      const key = idempotencyKey();
      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(addressPayload({ employeeId: employeeId('fail-conflict-a') }))
        .expect(202);

      const before = await prisma.payrollEvent.count({ where: { idempotencyKey: key } });

      await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', key)
        .send(addressPayload({ employeeId: employeeId('fail-conflict-b') }))
        .expect(409);

      const after = await prisma.payrollEvent.count({ where: { idempotencyKey: key } });
      expect(after).toBe(before);
    });
  });
});
