import { EventProcessingService } from './event-processing.service';

/**
 * Pure branch-logic coverage with a fake PrismaService — this is deliberately NOT where the
 * CAS's concurrency guarantee is proven (that requires real Postgres and lives in
 * test/worker-processing.e2e-spec.ts). This spec only checks that each of
 * EventProcessingService's branches reads its inputs and calls Prisma the way it should.
 */
describe('EventProcessingService', () => {
  const buildFakePrisma = (event: Record<string, unknown> | null) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...event, status: 'PROCESSING', attempts: 1 });
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

  it('is a safe no-op when the event does not exist', async () => {
    const { prisma } = buildFakePrisma(null);
    const service = new EventProcessingService(prisma as never);

    const result = await service.processEvent('missing-id');

    expect(result).toEqual({ outcome: 'missing' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['SUCCEEDED', 'FAILED'])(
    'is a safe no-op when the event is already terminal (%s)',
    async (status) => {
      const event = { id: 'e1', status };
      const { prisma } = buildFakePrisma(event);
      const service = new EventProcessingService(prisma as never);

      const result = await service.processEvent('e1');

      expect(result).toEqual({ outcome: 'terminal', event });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('is a safe no-op when the event is already PROCESSING', async () => {
    const event = { id: 'e1', status: 'PROCESSING' };
    const { prisma } = buildFakePrisma(event);
    const service = new EventProcessingService(prisma as never);

    const result = await service.processEvent('e1');

    expect(result).toEqual({ outcome: 'already-processing', event });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('claims a PENDING event: CAS update, re-read, and history insert all in one transaction', async () => {
    const event = { id: 'e1', status: 'PENDING' };
    const { prisma, updateMany, findUniqueOrThrow, create } = buildFakePrisma(event);
    const service = new EventProcessingService(prisma as never);

    const result = await service.processEvent('e1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'PROCESSING',
        attempts: { increment: 1 },
      }),
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'e1' } });
    expect(create).toHaveBeenCalledWith({
      data: {
        eventId: 'e1',
        fromStatus: 'PENDING',
        toStatus: 'PROCESSING',
        attemptNumber: 1,
      },
    });
    expect(result.outcome).toBe('claimed');
  });

  it('reports a lost race when the CAS update matches zero rows, without inserting history', async () => {
    const event = { id: 'e1', status: 'PENDING' };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    updateMany.mockResolvedValue({ count: 0 });
    const service = new EventProcessingService(prisma as never);

    const result = await service.processEvent('e1');

    expect(result).toEqual({ outcome: 'lost-race' });
    expect(create).not.toHaveBeenCalled();
  });
});
