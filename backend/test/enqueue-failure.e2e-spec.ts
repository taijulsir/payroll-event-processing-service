import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsService } from '../src/events/events.service';
import type { PayrollEventsQueueService } from '../src/processing/payroll-events-queue.service';

/**
 * Enqueue-failure behavior (this phase's §6: "Enqueue failure"). Deliberately NOT tested by
 * disrupting the real, shared Redis container — that would risk flakiness for every other
 * suite running against it. Instead, `EventsService` is constructed directly (bypassing Nest
 * DI) with a real PrismaService and a fake queue service whose `enqueue()` always rejects —
 * a fully deterministic way to force exactly the failure branch this test cares about.
 *
 * This is, strictly, an integration test (real Postgres) rather than a unit test, which is
 * why it lives here rather than under src/ alongside the pure-logic specs.
 */
describe('Enqueue failure does not roll back the committed event', () => {
  let prisma: PrismaService;

  const runPrefix = `enqueue-fail-${randomUUID()}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await prisma.$disconnect();
  });

  it('still returns the created event, and the row remains PENDING in Postgres, when enqueue fails', async () => {
    const failingQueue = {
      enqueue: jest.fn().mockRejectedValue(new Error('Redis unreachable (simulated)')),
    } as unknown as PayrollEventsQueueService;

    const eventsService = new EventsService(prisma, failingQueue);
    const employeeId = `${runPrefix}-emp-1`;

    const { event, deduplicated } = await eventsService.submit(
      `${runPrefix}-idem-1`,
      'ADDRESS_CHANGE',
      {
        employeeId,
        effectiveDate: '2026-01-01',
        street: '1 Example Street',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
      },
    );

    // The method must not throw despite the queue rejecting — asserted implicitly by
    // reaching this line — and must report a genuine (non-deduplicated) creation.
    expect(deduplicated).toBe(false);
    expect(failingQueue.enqueue).toHaveBeenCalledWith(event.id);

    // The event is durably PENDING in Postgres regardless of the enqueue failure — this is
    // the actual guarantee this phase's design provides; recovery is the future
    // reconciliation sweep's job, not this method's.
    const row = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('PENDING');
    expect(row.employeeId).toBe(employeeId);
  });
});
