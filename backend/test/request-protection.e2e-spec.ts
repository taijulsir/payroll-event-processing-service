import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureBodyParser, REQUEST_BODY_SIZE_LIMIT } from '../src/http-bootstrap';
import {
  EVENTS_SUBMIT_RATE_LIMIT,
  EVENTS_SUBMIT_RATE_LIMIT_WINDOW_MS,
} from '../src/events/events.constants';

/**
 * Production-appropriate `POST /events` protections: rate limiting (events.constants.ts,
 * wired via events.controller.ts + app.module.ts's ThrottlerModule) and the request body size
 * limit (http-bootstrap.ts, wired via main.ts). Both are HTTP-edge concerns, deliberately
 * unrelated to and untested-here retry/backoff/ordering/reconciliation behavior — those already
 * have their own dedicated e2e suites.
 *
 * Runs against a real PostgreSQL (see backend/.env / docker-compose.yml), matching this
 * codebase's existing e2e convention — but every request in the rate-limiting suite below is
 * deliberately invalid (missing Idempotency-Key), so the throttler guard rejects/observes them
 * before any database write would happen; no cleanup is needed there. The body-size suite does
 * submit one genuinely valid event to prove the limit doesn't affect normal traffic, and cleans
 * that row up like every other e2e suite in this codebase.
 */
describe('POST /events request protection', () => {
  describe('rate limiting', () => {
    let app: INestApplication;

    // A fresh Test.createTestingModule(...) compiles a fresh ThrottlerModule with its own
    // in-memory storage (see app.module.ts) — this suite's request budget is isolated from
    // every other e2e file's, including the ~36-request burst events-submission.e2e-spec.ts
    // issues in the same process during a full `npm run test:e2e` run.
    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    // Deliberately invalid (no Idempotency-Key -> 400) so the throttler guard's own accounting
    // is exercised without ever reaching Postgres — the guard runs before validation, so an
    // invalid request still consumes exactly one unit of rate-limit budget, which is the
    // property this test needs.
    const throttledProbe = () => request(app.getHttpServer()).post('/events').send({});

    it(`allows exactly ${EVENTS_SUBMIT_RATE_LIMIT} requests within the window, then rejects the next with 429`, async () => {
      for (let i = 0; i < EVENTS_SUBMIT_RATE_LIMIT; i++) {
        const res = await throttledProbe();
        expect(res.status).not.toBe(429); // still within budget — the guard let it through to validation (400)
        expect(res.status).toBe(400);
      }

      const blocked = await throttledProbe();
      expect(blocked.status).toBe(429);
      expect(blocked.body.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(
        EVENTS_SUBMIT_RATE_LIMIT_WINDOW_MS / 1000,
      );
    });

    it('does not throttle unrelated routes (GET /events, GET /health) while POST /events is blocked', async () => {
      // The previous test already exhausted this suite's own app instance's budget; if it
      // hasn't (test order changes), exhaust it here too — either way, by this point further
      // POSTs from this app are blocked.
      await throttledProbe();

      const [listRes, healthRes] = await Promise.all([
        request(app.getHttpServer()).get('/events'),
        request(app.getHttpServer()).get('/health'),
      ]);

      expect(listRes.status).toBe(200);
      expect(healthRes.status).toBe(200);
    });
  });

  describe('request body size limit', () => {
    let app: NestExpressApplication;
    let prisma: PrismaService;

    const runPrefix = `size-test-${randomUUID()}`;
    const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;
    const idempotencyKey = () => `${runPrefix}-idem-${randomUUID()}`;

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      // Mirrors main.ts's own bootstrap exactly (bodyParser: false + configureBodyParser) —
      // this is what makes this test verify the actual configured limit rather than Nest's
      // default 100kb, which `moduleFixture.createNestApplication()` would otherwise apply.
      app = moduleFixture.createNestApplication<NestExpressApplication>({ bodyParser: false });
      configureBodyParser(app);
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

    it(`rejects a body larger than ${REQUEST_BODY_SIZE_LIMIT} with 413, before it reaches validation or the database`, async () => {
      const before = await prisma.payrollEvent.count({
        where: { employeeId: { startsWith: runPrefix } },
      });

      // Comfortably over the 64kb limit; the specific field doesn't matter — the body-parser
      // rejects on raw byte size before any field-level validation runs.
      const oversized = addressPayload({
        employeeId: employeeId('oversized'),
        street: 'x'.repeat(200_000),
      });

      const res = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(oversized);

      expect(res.status).toBe(413);

      const after = await prisma.payrollEvent.count({
        where: { employeeId: { startsWith: runPrefix } },
      });
      expect(after).toBe(before); // no row written for a rejected oversized body
    });

    it('still accepts a normal, well-within-limit event (the limit does not affect real traffic)', async () => {
      const res = await request(app.getHttpServer())
        .post('/events')
        .set('Idempotency-Key', idempotencyKey())
        .send(addressPayload({ employeeId: employeeId('normal') }))
        .expect(202);

      expect(res.body.status).toBe('PENDING');
    });
  });
});
