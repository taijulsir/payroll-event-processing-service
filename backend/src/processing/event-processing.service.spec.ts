import { EventProcessingService } from './event-processing.service';
import type { PayrollProvider, PayrollProviderOutcome } from './payroll-provider';

/**
 * Pure branch-logic coverage with a fake PrismaService — this is deliberately NOT where the
 * CAS's concurrency guarantee is proven (that requires real Postgres and lives in
 * test/payroll-provider.e2e-spec.ts, test/worker-processing.e2e-spec.ts, and
 * test/retry-backoff.e2e-spec.ts). This spec checks that each of EventProcessingService's
 * branches reads its inputs, calls Prisma, and calls the provider (or doesn't) the way it
 * should.
 */
describe('EventProcessingService', () => {
  /**
   * `attempts` is tracked as mutable state across a test's calls (not hardcoded), because
   * real behavior only increments it on the CLAIM step's own `updateMany` (never on the
   * retry-transition or finalize steps) — several of this phase's tests need to observe a
   * realistic, correctly-incremented value across a claim -> retry/finalize sequence within
   * one `processEvent()` call.
   */
  const buildFakePrisma = (event: Record<string, unknown> | null) => {
    let currentAttempts = (event?.attempts as number | undefined) ?? 0;

    const updateMany = jest.fn().mockImplementation((args: { data?: Record<string, unknown> }) => {
      const attemptsOp = args?.data?.attempts as { increment?: number } | undefined;
      if (attemptsOp?.increment) {
        currentAttempts += attemptsOp.increment;
      }
      return Promise.resolve({ count: 1 });
    });
    const findUniqueOrThrow = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ ...event, status: 'PROCESSING', attempts: currentAttempts }),
      );
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
      maxAttempts: 5,
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
    // Only one provider call for a successful single-attempt run — no retry.
    expect(provider.apply).toHaveBeenCalledTimes(1);
  });

  it('claims a PENDING event, calls the provider, and on PERMANENT FAILURE finalizes PROCESSING -> FAILED (no retry)', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
      maxAttempts: 5,
    };
    const { prisma, updateMany, create } = buildFakePrisma(event);
    const provider = buildFakeProvider({
      outcome: 'FAILURE',
      classification: 'PERMANENT',
      failureReason: 'business rejection',
    });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    expect(updateMany).toHaveBeenCalledTimes(2); // claim + finalize — no retry transition
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
    expect(provider.apply).toHaveBeenCalledTimes(1);
  });

  it('does not set result on a FAILURE finalize', async () => {
    const event = {
      id: 'e1',
      status: 'PENDING',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
      maxAttempts: 5,
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

  describe('R2: retry transition + attempt budget', () => {
    it('a TRANSIENT failure with budget remaining returns PROCESSING -> PENDING (retry-scheduled), never invokes the provider twice, and does not increment attempts again', async () => {
      const event = {
        id: 'e1',
        status: 'PENDING',
        employeeId: 'emp-1',
        eventType: 'ADDRESS_CHANGE',
        payload: {},
        attempts: 1, // this claim becomes attempt 2 of 5 — budget remains
        maxAttempts: 5,
      };
      const { prisma, updateMany, create } = buildFakePrisma(event);
      const provider = buildFakeProvider({
        outcome: 'FAILURE',
        classification: 'TRANSIENT',
        failureReason: 'temporary outage',
      });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(updateMany).toHaveBeenCalledTimes(2); // claim + retry transition
      // The retry transition must NOT touch `attempts` — only the claim step does.
      const retryCallArgs = updateMany.mock.calls[1][0];
      expect(retryCallArgs).toEqual({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PENDING' }),
      });
      expect(retryCallArgs.data.attempts).toBeUndefined();
      expect(retryCallArgs.data.processingFinishedAt).toBeUndefined(); // not terminal
      expect(retryCallArgs.data.failureType).toBeUndefined(); // status column only, no failure fields

      expect(create).toHaveBeenNthCalledWith(2, {
        data: {
          eventId: 'e1',
          fromStatus: 'PROCESSING',
          toStatus: 'PENDING',
          attemptNumber: 2,
          errorMessage: 'temporary outage',
        },
      });

      expect(result.outcome).toBe('retry-scheduled');
      expect(provider.apply).toHaveBeenCalledTimes(1); // never called twice in one processEvent() run
    });

    it('a successful re-claim after a retry increments attempts again (2, then 3, ...)', async () => {
      const event = {
        id: 'e1',
        status: 'PENDING',
        employeeId: 'emp-1',
        eventType: 'ADDRESS_CHANGE',
        payload: {},
        attempts: 2, // already retried twice; this claim becomes attempt 3
        maxAttempts: 5,
      };
      const { prisma, updateMany, create } = buildFakePrisma(event);
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: { ok: true } });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'e1', status: 'PENDING' },
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      });
      expect(create).toHaveBeenNthCalledWith(1, {
        data: {
          eventId: 'e1',
          fromStatus: 'PENDING',
          toStatus: 'PROCESSING',
          attemptNumber: 3,
        },
      });
      expect(result.outcome).toBe('succeeded');
    });

    it('a TRANSIENT failure exactly at maxAttempts finalizes to FAILED/RETRYABLE, not another retry', async () => {
      const event = {
        id: 'e1',
        status: 'PENDING',
        employeeId: 'emp-1',
        eventType: 'ADDRESS_CHANGE',
        payload: {},
        attempts: 4, // this claim becomes attempt 5 of 5 — budget exhausted by this attempt
        maxAttempts: 5,
      };
      const { prisma, updateMany, create } = buildFakePrisma(event);
      const provider = buildFakeProvider({
        outcome: 'FAILURE',
        classification: 'TRANSIENT',
        failureReason: 'still down',
      });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(updateMany).toHaveBeenCalledTimes(2); // claim + terminal finalize — no retry transition
      expect(updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({
          status: 'FAILED',
          failureType: 'RETRYABLE',
          failureReason: 'still down',
        }),
      });
      expect(create).toHaveBeenNthCalledWith(2, {
        data: {
          eventId: 'e1',
          fromStatus: 'PROCESSING',
          toStatus: 'FAILED',
          attemptNumber: 5,
          errorMessage: 'still down',
        },
      });
      expect(result.outcome).toBe('failed');
      expect(provider.apply).toHaveBeenCalledTimes(1); // exhaustion is decided without a 6th provider call
    });

    it('reports a lost race if the retry-transition CAS matches zero rows (defensive — no other caller can reach this in this phase)', async () => {
      const event = {
        id: 'e1',
        status: 'PENDING',
        employeeId: 'emp-1',
        eventType: 'ADDRESS_CHANGE',
        payload: {},
        attempts: 0,
        maxAttempts: 5,
      };
      const { prisma, updateMany } = buildFakePrisma(event);
      updateMany.mockResolvedValueOnce({ count: 1 }); // claim succeeds
      updateMany.mockResolvedValueOnce({ count: 0 }); // retry-transition CAS loses
      const provider = buildFakeProvider({
        outcome: 'FAILURE',
        classification: 'TRANSIENT',
        failureReason: 'temporary outage',
      });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(result).toEqual({ outcome: 'lost-race' });
    });
  });

  describe('R3: reconcileExhaustedJob (BullMQ failed-event backstop)', () => {
    const buildService = (event: Record<string, unknown> | null) => {
      const fake = buildFakePrisma(event);
      // reconcileExhaustedJob never calls the provider — pass a provider that would fail the
      // test loudly if it were ever invoked, to prove that structurally.
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(fake.prisma as never, provider);
      return { ...fake, provider, service };
    };

    it('is a no-op when the event does not exist', async () => {
      const { service, prisma, provider } = buildService(null);

      const reconciled = await service.reconcileExhaustedJob('missing-id');

      expect(reconciled).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    });

    it.each(['SUCCEEDED', 'FAILED'])('is a no-op when the event is already %s', async (status) => {
      const { service, prisma, provider } = buildService({ id: 'e1', status });

      const reconciled = await service.reconcileExhaustedJob('e1');

      expect(reconciled).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    });

    it('is a no-op when the event is PENDING (legitimately awaiting its own scheduled retry, or already reclaimed)', async () => {
      const { service, prisma, provider } = buildService({ id: 'e1', status: 'PENDING' });

      const reconciled = await service.reconcileExhaustedJob('e1');

      expect(reconciled).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    });

    it('finalizes a PROCESSING event to FAILED/RETRYABLE, with one history row, and never touches attempts', async () => {
      const { service, updateMany, create } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 5,
        maxAttempts: 5,
      });

      const reconciled = await service.reconcileExhaustedJob('e1');

      expect(reconciled).toBe(true);
      expect(updateMany).toHaveBeenCalledTimes(1);
      const call = updateMany.mock.calls[0][0];
      expect(call).toEqual({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'FAILED', failureType: 'RETRYABLE' }),
      });
      expect(call.data.attempts).toBeUndefined(); // never touched by the backstop
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'e1',
          fromStatus: 'PROCESSING',
          toStatus: 'FAILED',
          attemptNumber: 5,
        }),
      });
    });

    it('returns false (no-op) if the finalize CAS loses the race', async () => {
      const { service, updateMany } = buildService({ id: 'e1', status: 'PROCESSING' });
      updateMany.mockResolvedValueOnce({ count: 0 });

      const reconciled = await service.reconcileExhaustedJob('e1');

      expect(reconciled).toBe(false);
    });

    it('is idempotent: calling it twice in a row only finalizes once', async () => {
      const event = { id: 'e1', status: 'PROCESSING', attempts: 5, maxAttempts: 5 };
      const { prisma, updateMany, create } = buildFakePrisma(event);
      // After the first call finalizes, simulate the event now being FAILED for the second call.
      const findUnique = jest
        .fn()
        .mockResolvedValueOnce(event)
        .mockResolvedValueOnce({
          ...event,
          status: 'FAILED',
        });
      (prisma.payrollEvent as { findUnique: typeof findUnique }).findUnique = findUnique;
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(prisma as never, provider);

      const first = await service.reconcileExhaustedJob('e1');
      const second = await service.reconcileExhaustedJob('e1');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe('R4: recoverStaleProcessing (stale-processing sweep)', () => {
    const buildService = (event: Record<string, unknown> | null) => {
      const fake = buildFakePrisma(event);
      // recoverStaleProcessing never calls the provider — a provider that would fail loudly
      // if invoked proves that structurally.
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(fake.prisma as never, provider);
      return { ...fake, provider, service };
    };

    it('is a no-op ("missing") when the event does not exist', async () => {
      const { service, prisma, provider } = buildService(null);

      const result = await service.recoverStaleProcessing('missing-id');

      expect(result).toEqual({ outcome: 'missing' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    });

    it.each(['SUCCEEDED', 'FAILED', 'PENDING'])(
      'is a no-op ("not-processing") when the event is %s, not PROCESSING',
      async (status) => {
        const event = { id: 'e1', status };
        const { service, prisma, provider } = buildService(event);

        const result = await service.recoverStaleProcessing('e1');

        expect(result).toEqual({ outcome: 'not-processing', event });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(provider.apply).not.toHaveBeenCalled();
      },
    );

    it('returns a PROCESSING event with budget remaining to PENDING, without touching attempts', async () => {
      const { service, updateMany, create } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 2,
        maxAttempts: 5,
      });

      const result = await service.recoverStaleProcessing('e1');

      expect(result.outcome).toBe('retry-scheduled');
      expect(updateMany).toHaveBeenCalledTimes(1);
      const call = updateMany.mock.calls[0][0];
      expect(call).toEqual({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PENDING' }),
      });
      expect(call.data.attempts).toBeUndefined(); // never touched by recovery
      expect(call.data.processingFinishedAt).toBeUndefined(); // not a terminal transition
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'e1',
          fromStatus: 'PROCESSING',
          toStatus: 'PENDING',
          attemptNumber: 2,
        }),
      });
    });

    it('finalizes a PROCESSING event whose budget is already exhausted to FAILED/RETRYABLE (does not return it to PENDING)', async () => {
      const { service, updateMany, create } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 5,
        maxAttempts: 5,
      });

      const result = await service.recoverStaleProcessing('e1');

      expect(result.outcome).toBe('failed');
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'FAILED', failureType: 'RETRYABLE' }),
      });
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'e1',
          fromStatus: 'PROCESSING',
          toStatus: 'FAILED',
          attemptNumber: 5,
        }),
      });
    });

    it('persists a fixed, generic, domain-oriented reason — never a raw crash/error detail (there is none to leak: this method takes no external error input)', async () => {
      const { service, create } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 1,
        maxAttempts: 5,
      });

      await service.recoverStaleProcessing('e1');

      const historyCall = create.mock.calls[0][0];
      expect(historyCall.data.errorMessage).toMatch(/abandoned/i);
      expect(historyCall.data.errorMessage).toMatch(/threshold/i);
    });

    it('is a no-op if the CAS loses the race while returning to PENDING (a live worker finished first)', async () => {
      const { service, updateMany } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 1,
        maxAttempts: 5,
      });
      updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.recoverStaleProcessing('e1');

      expect(result).toEqual({ outcome: 'lost-race' });
    });

    it('is a no-op if the CAS loses the race while finalizing an exhausted event', async () => {
      const { service, updateMany } = buildService({
        id: 'e1',
        status: 'PROCESSING',
        attempts: 5,
        maxAttempts: 5,
      });
      updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.recoverStaleProcessing('e1');

      expect(result).toEqual({ outcome: 'lost-race' });
    });

    it('is idempotent: calling it twice in a row only transitions once', async () => {
      const event = { id: 'e1', status: 'PROCESSING', attempts: 2, maxAttempts: 5 };
      const { prisma, updateMany, create } = buildFakePrisma(event);
      const findUnique = jest
        .fn()
        .mockResolvedValueOnce(event)
        .mockResolvedValueOnce({ ...event, status: 'PENDING' });
      (prisma.payrollEvent as { findUnique: typeof findUnique }).findUnique = findUnique;
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(prisma as never, provider);

      const first = await service.recoverStaleProcessing('e1');
      const second = await service.recoverStaleProcessing('e1');

      expect(first.outcome).toBe('retry-scheduled');
      expect(second).toEqual({ outcome: 'not-processing', event: { ...event, status: 'PENDING' } });
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
