import { EventProcessingService } from './event-processing.service';
import type { PayrollProvider, PayrollProviderOutcome } from './payroll-provider';

/**
 * Pure branch-logic coverage with a fake PrismaService — this is deliberately NOT where the
 * CAS's concurrency guarantee is proven (that requires real Postgres and lives in
 * test/payroll-provider.e2e-spec.ts and test/worker-processing.e2e-spec.ts). This spec checks
 * that each of EventProcessingService's branches reads its inputs, calls Prisma, and calls the
 * provider (or doesn't) the way it should.
 */
describe('EventProcessingService', () => {
  const buildFakePrisma = (event: Record<string, unknown> | null) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = jest
      .fn()
      .mockImplementation(() => Promise.resolve({ ...event, status: 'PROCESSING', attempts: 1 }));
    const create = jest.fn().mockResolvedValue(undefined);

    const tx = {
      payrollEvent: { updateMany, findUniqueOrThrow },
      eventStatusHistory: { create },
    };

    const prisma = {
      payrollEvent: { findUnique: jest.fn().mockResolvedValue(event) },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };

    return { prisma, tx, updateMany, findUniqueOrThrow, create };
  };

  const buildFakeProvider = (outcome: PayrollProviderOutcome) => {
    const apply = jest.fn().mockResolvedValue(outcome);
    return { apply } as unknown as PayrollProvider & { apply: jest.Mock };
  };

  it('is a safe no-op when the event does not exist', async () => {
    const { prisma } = buildFakePrisma(null);
    const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('missing-id');

    expect(result).toEqual({ outcome: 'missing' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.apply).not.toHaveBeenCalled();
  });

  it.each(['SUCCEEDED', 'FAILED'])(
    'is a safe no-op when the event is already terminal (%s): provider is not called',
    async (status) => {
      const event = { id: 'e1', status };
      const { prisma } = buildFakePrisma(event);
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(result).toEqual({ outcome: 'terminal', event });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    },
  );

  it('is a safe no-op when the event is already PROCESSING: provider is not called', async () => {
    const event = { id: 'e1', status: 'PROCESSING' };
    const { prisma } = buildFakePrisma(event);
    const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    expect(result).toEqual({ outcome: 'already-processing', event });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.apply).not.toHaveBeenCalled();
  });

  it('reports a lost race when the initial CAS matches zero rows, without calling the provider', async () => {
    const event = { id: 'e1', status: 'PENDING' };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    updateMany.mockResolvedValueOnce({ count: 0 });
    const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    expect(result).toEqual({ outcome: 'lost-race' });
    expect(create).not.toHaveBeenCalled();
    expect(provider.apply).not.toHaveBeenCalled();
  });

  it('claims a PENDING event, calls the provider, and on SUCCESS finalizes PROCESSING -> SUCCEEDED', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    const providerResult = { providerReference: 'sim-e1' };
    const provider = buildFakeProvider({ outcome: 'SUCCESS', result: providerResult });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    // First updateMany call: the PENDING -> PROCESSING claim.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'e1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'PROCESSING', attempts: { increment: 1 } }),
    });
    expect(provider.apply).toHaveBeenCalledWith({
      eventId: 'e1',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    });
    // Second updateMany call: the PROCESSING -> SUCCEEDED finalize.
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'e1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'SUCCEEDED', result: providerResult }),
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      data: {
        eventId: 'e1',
        fromStatus: 'PROCESSING',
        toStatus: 'SUCCEEDED',
        attemptNumber: 1,
      },
    });
    expect(result.outcome).toBe('succeeded');
  });

  it('claims a PENDING event, calls the provider, and on FAILURE finalizes PROCESSING -> FAILED', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    const provider = buildFakeProvider({
      outcome: 'FAILURE',
      classification: 'PERMANENT',
      failureReason: 'business rejection',
    });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'e1', status: 'PROCESSING' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: 'business rejection',
        failureType: 'PERMANENT',
      }),
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      data: {
        eventId: 'e1',
        fromStatus: 'PROCESSING',
        toStatus: 'FAILED',
        attemptNumber: 1,
        errorMessage: 'business rejection',
      },
    });
    expect(result.outcome).toBe('failed');
  });

  it('does not set result on a FAILURE finalize', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    };
    const { prisma, updateMany } = buildFakePrisma(event);
    const provider = buildFakeProvider({
      outcome: 'FAILURE',
      classification: 'PERMANENT',
      failureReason: 'nope',
    });
    const service = new EventProcessingService(prisma as never, provider);

    await service.processEvent('e1');

    const finalizeCall = updateMany.mock.calls[1][0];
    expect(finalizeCall.data.result).toBeUndefined();
  });

  it('R1: a TRANSIENT classification does not change lifecycle behavior — still finalizes straight to FAILED/PERMANENT (retry not implemented yet)', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    const provider = buildFakeProvider({
      outcome: 'FAILURE',
      classification: 'TRANSIENT',
      failureReason: 'temporary outage',
    });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    // Exactly two updateMany calls total (claim + finalize) — no third call returning the
    // event to PENDING, proving no retry transition exists in this phase.
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'e1', status: 'PROCESSING' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureType: 'PERMANENT', // unconditional today, regardless of classification
        failureReason: 'temporary outage',
      }),
    });
    expect(create).toHaveBeenCalledTimes(2); // claim history + terminal FAILED history only
    expect(result.outcome).toBe('failed');
  });
});
