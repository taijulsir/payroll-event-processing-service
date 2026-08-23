import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Database foundation verification (docs/database-design.md).
 *
 * This is, strictly, an integration test against a real PostgreSQL instance rather than an
 * HTTP end-to-end test — it is placed alongside the e2e suite (and run via `npm run
 * test:e2e`) because introducing a separate "integration" Jest project is out of scope for
 * this phase; that refinement is expected to land naturally once Phase 3's submission API
 * introduces its own integration tests.
 *
 * No business logic (idempotency handling, sequence allocation, CAS transitions) is
 * exercised here — only that the schema itself (tables, constraints, indexes, the foreign
 * key, and its delete behavior) matches docs/database-design.md.
 *
 * Requires a reachable PostgreSQL with the migration applied — see backend/.env /
 * docker-compose.yml.
 */
describe('Database schema (Prisma foundation)', () => {
  const prisma = new PrismaService();

  // Every row created by this suite uses this prefix so cleanup can find them reliably,
  // regardless of which individual assertions passed or failed.
  const runPrefix = `schema-test-${randomUUID()}`;
  let eventCounter = 0;

  const uniqueEmployeeId = () => `${runPrefix}-employee-${++eventCounter}`;
  const uniqueIdempotencyKey = () => `${runPrefix}-idem-${randomUUID()}`;

  const basePayrollEvent = () => ({
    employeeId: uniqueEmployeeId(),
    eventType: 'ADDRESS_CHANGE',
    sequence: 1,
    idempotencyKey: uniqueIdempotencyKey(),
    payload: { employeeId: 'irrelevant-for-schema-test', effectiveDate: '2026-01-01' },
    maxAttempts: 5,
  });

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    // Children first — the FK has no cascade, so parents must be deleted after.
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({
      where: { employeeId: { startsWith: runPrefix } },
    });
    await prisma.$disconnect();
  });

  it('connects to PostgreSQL and can execute a query', async () => {
    const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
    expect(result).toEqual([{ ok: 1 }]);
  });

  it('creates a payroll_events row with all required fields and reads it back', async () => {
    const created = await prisma.payrollEvent.create({ data: basePayrollEvent() });

    expect(created.id).toBeDefined();
    expect(created.status).toBe('PENDING');
    expect(created.attempts).toBe(0);
    expect(created.submittedAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(created.processingStartedAt).toBeNull();
    expect(created.result).toBeNull();

    const found = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.idempotencyKey).toBe(created.idempotencyKey);
  });

  it('enforces UNIQUE(idempotency_key)', async () => {
    const shared = basePayrollEvent();
    await prisma.payrollEvent.create({ data: shared });

    await expect(
      prisma.payrollEvent.create({
        data: { ...shared, employeeId: uniqueEmployeeId() }, // different employee, same key
      }),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE(employee_id, sequence)', async () => {
    const employeeId = uniqueEmployeeId();
    await prisma.payrollEvent.create({
      data: { ...basePayrollEvent(), employeeId, sequence: 7 },
    });

    await expect(
      prisma.payrollEvent.create({
        data: { ...basePayrollEvent(), employeeId, sequence: 7 }, // same employee + sequence
      }),
    ).rejects.toThrow();
  });

  it('creates an event_status_history row referencing its parent event', async () => {
    const event = await prisma.payrollEvent.create({ data: basePayrollEvent() });

    const history = await prisma.eventStatusHistory.create({
      data: { eventId: event.id, fromStatus: null, toStatus: 'PENDING' },
    });

    expect(history.eventId).toBe(event.id);

    const historyForEvent = await prisma.eventStatusHistory.findMany({
      where: { eventId: event.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(historyForEvent).toHaveLength(1);
  });

  it('enforces the foreign key — rejects a history row referencing a non-existent event', async () => {
    await expect(
      prisma.eventStatusHistory.create({
        data: { eventId: randomUUID(), fromStatus: null, toStatus: 'PENDING' },
      }),
    ).rejects.toThrow();
  });

  it('does not cascade on delete — rejects deleting a payroll_events row that still has history', async () => {
    const event = await prisma.payrollEvent.create({ data: basePayrollEvent() });
    await prisma.eventStatusHistory.create({
      data: { eventId: event.id, fromStatus: null, toStatus: 'PENDING' },
    });

    await expect(prisma.payrollEvent.delete({ where: { id: event.id } })).rejects.toThrow();

    // Both rows must still exist — the delete must have been rejected, not partially applied.
    await expect(
      prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).resolves.toBeDefined();
  });

  it('enforces CHECK(failure_type IN (RETRYABLE, PERMANENT) OR NULL)', async () => {
    await expect(
      prisma.payrollEvent.create({
        data: { ...basePayrollEvent(), failureType: 'NOT_A_REAL_FAILURE_TYPE' },
      }),
    ).rejects.toThrow();
  });

  it('enforces CHECK(attempts >= 0)', async () => {
    await expect(
      prisma.payrollEvent.create({ data: { ...basePayrollEvent(), attempts: -1 } }),
    ).rejects.toThrow();
  });

  it('enforces CHECK(max_attempts > 0)', async () => {
    await expect(
      prisma.payrollEvent.create({ data: { ...basePayrollEvent(), maxAttempts: 0 } }),
    ).rejects.toThrow();
  });

  it('enforces CHECK(sequence > 0)', async () => {
    await expect(
      prisma.payrollEvent.create({ data: { ...basePayrollEvent(), sequence: 0 } }),
    ).rejects.toThrow();
  });

  it('does NOT enforce a database-level CHECK on status (application-layer validation only)', async () => {
    // This intentionally proves the approved decision in docs/database-design.md §7: an
    // out-of-model string is rejected by application code (later phases), not by the
    // database. If this test ever starts failing because a CHECK was reintroduced, that is
    // an architectural regression, not a bug in this test.
    const created = await prisma.payrollEvent.create({
      data: { ...basePayrollEvent(), status: 'NOT_A_REAL_STATUS' },
    });
    expect(created.status).toBe('NOT_A_REAL_STATUS');
  });

  it('does NOT enforce a database-level CHECK on event_type (application-layer validation only)', async () => {
    const created = await prisma.payrollEvent.create({
      data: { ...basePayrollEvent(), eventType: 'NOT_A_REAL_EVENT_TYPE' },
    });
    expect(created.eventType).toBe('NOT_A_REAL_EVENT_TYPE');
  });
});
