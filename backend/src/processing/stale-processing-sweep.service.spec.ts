import { StaleProcessingSweepService } from './stale-processing-sweep.service';
import type { EventProcessingService, ProcessEventResult } from './event-processing.service';
import type { PayrollEventsQueueService } from './payroll-events-queue.service';

describe('StaleProcessingSweepService', () => {
  const buildFakePrisma = (candidateIds: string[]) => {
    const findMany = jest.fn().mockResolvedValue(candidateIds.map((id) => ({ id })));
    return { payrollEvent: { findMany } };
  };

  const buildService = (
    candidateIds: string[],
    recoverResults: Record<string, ProcessEventResult | Error>,
  ) => {
    const prisma = buildFakePrisma(candidateIds);
    const recoverStaleProcessing = jest.fn(async (eventId: string) => {
      const result = recoverResults[eventId];
      if (result instanceof Error) throw result;
      return result;
    });
    const eventProcessingService = {
      recoverStaleProcessing,
    } as unknown as EventProcessingService;
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const queue = { enqueue } as unknown as PayrollEventsQueueService;

    const service = new StaleProcessingSweepService(prisma as never, eventProcessingService, queue);

    return { service, prisma, recoverStaleProcessing, enqueue };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('queries only PROCESSING events, and does nothing else when there are no candidates', async () => {
    const { service, prisma, enqueue } = buildService([], {});

    await service.runSweep();

    expect(prisma.payrollEvent.findMany).toHaveBeenCalledWith({
      where: { status: 'PROCESSING', processingStartedAt: { lt: expect.any(Date) } },
      select: { id: true },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues (jobId = eventId, minimal payload) only events recovery returned to PENDING', async () => {
    const { service, recoverStaleProcessing, enqueue } = buildService(['e1', 'e2', 'e3'], {
      e1: { outcome: 'retry-scheduled' },
      e2: { outcome: 'failed' }, // exhausted — no re-enqueue
      e3: { outcome: 'not-processing' }, // already moved on — no re-enqueue
    });

    await service.runSweep();

    expect(recoverStaleProcessing).toHaveBeenCalledTimes(3);
    expect(recoverStaleProcessing).toHaveBeenCalledWith('e1');
    expect(recoverStaleProcessing).toHaveBeenCalledWith('e2');
    expect(recoverStaleProcessing).toHaveBeenCalledWith('e3');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('e1');
  });

  it("a lost race on one candidate ('lost-race' outcome) does not re-enqueue and does not stop the sweep", async () => {
    const { service, enqueue, recoverStaleProcessing } = buildService(['e1', 'e2'], {
      e1: { outcome: 'lost-race' },
      e2: { outcome: 'retry-scheduled' },
    });

    await service.runSweep();

    expect(recoverStaleProcessing).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('e2');
  });

  it('an error recovering one candidate does not abort the rest of the sweep', async () => {
    const { service, recoverStaleProcessing, enqueue } = buildService(['e1', 'e2'], {
      e1: new Error('db blip'),
      e2: { outcome: 'retry-scheduled' },
    });

    await expect(service.runSweep()).resolves.toBeUndefined(); // does not throw
    expect(recoverStaleProcessing).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('e2');
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
