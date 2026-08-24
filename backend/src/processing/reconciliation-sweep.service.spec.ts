import { ReconciliationSweepService } from './reconciliation-sweep.service';
import type { PayrollEventsQueueService } from './payroll-events-queue.service';

describe('ReconciliationSweepService', () => {
  const buildFakePrisma = (candidateIds: string[]) => {
    const findMany = jest.fn().mockResolvedValue(candidateIds.map((id) => ({ id })));
    return { payrollEvent: { findMany } };
  };

  const buildService = (candidateIds: string[], enqueueBehavior: Record<string, Error | void>) => {
    const prisma = buildFakePrisma(candidateIds);
    const enqueue = jest.fn(async (eventId: string) => {
      const behavior = enqueueBehavior[eventId];
      if (behavior instanceof Error) throw behavior;
    });
    const queue = { enqueue } as unknown as PayrollEventsQueueService;

    const service = new ReconciliationSweepService(prisma as never, queue);

    return { service, prisma, enqueue };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('queries only PENDING events older than the age threshold, and does nothing else when there are no candidates', async () => {
    const { service, prisma, enqueue } = buildService([], {});

    await service.runSweep();

    expect(prisma.payrollEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', submittedAt: { lt: expect.any(Date) } },
      select: { id: true },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the candidate query has no LIMIT/take clause (approved: unbounded batch size)', async () => {
    const { service, prisma } = buildService([], {});

    await service.runSweep();

    const callArgs = prisma.payrollEvent.findMany.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('take');
  });

  it('attempts a best-effort enqueue for every candidate found, jobId = eventId (via the shared queue service)', async () => {
    const { service, enqueue } = buildService(['e1', 'e2', 'e3'], {});

    await service.runSweep();

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith('e1');
    expect(enqueue).toHaveBeenCalledWith('e2');
    expect(enqueue).toHaveBeenCalledWith('e3');
  });

  it('never touches payrollEvent write methods — no status mutation, ever', async () => {
    const { service, prisma } = buildService(['e1'], {});

    await service.runSweep();

    expect(prisma.payrollEvent).not.toHaveProperty('update');
    expect(prisma.payrollEvent).not.toHaveProperty('updateMany');
  });

  it('an enqueue failure for one candidate does not abort the rest of the sweep, and does not throw', async () => {
    const { service, enqueue } = buildService(['e1', 'e2'], {
      e1: new Error('redis unreachable'),
    });

    await expect(service.runSweep()).resolves.toBeUndefined(); // does not throw
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith('e1');
    expect(enqueue).toHaveBeenCalledWith('e2');
  });

  it('running the sweep repeatedly is safe — each run independently re-queries and re-attempts', async () => {
    const { service, prisma, enqueue } = buildService(['e1'], {});

    await service.runSweep();
    await service.runSweep();

    expect(prisma.payrollEvent.findMany).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, 'e1');
    expect(enqueue).toHaveBeenNthCalledWith(2, 'e1');
  });

  it('lifecycle: onModuleInit runs a sweep immediately and schedules a repeating one; onModuleDestroy clears it', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { service, prisma } = buildService([], {});

    await service.onModuleInit();

    expect(prisma.payrollEvent.findMany).toHaveBeenCalledTimes(1); // "on startup"
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
