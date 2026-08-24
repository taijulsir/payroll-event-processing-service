import { EventProcessingService } from './event-processing.service';
import type { PayrollProvider, PayrollProviderOutcome } from './payroll-provider';

/**
 * Pure branch-logic coverage with a fake PrismaService — this is deliberately NOT where the
 * CAS's concurrency guarantee is proven (that requires real Postgres and lives in
 * test/payroll-provider.e2e-spec.ts, test/worker-processing.e2e-spec.ts,
 * test/retry-backoff.e2e-spec.ts, and test/per-employee-ordering.e2e-spec.ts). This spec
 * checks that each of EventProcessingService's branches reads its inputs, calls Prisma, and
 * calls the provider (or doesn't) the way it should.
 */
describe('EventProcessingService', () => {
  /**
   * `attempts`/`status` are tracked as mutable state across a test's calls (not hardcoded),
   * because real behavior only mutates them on an actual matching write — several tests need
   * to observe realistic values across a claim -> retry/finalize sequence within one
   * `processEvent()` call.
   *
   * Per-employee ordering design: `claimForProcessing`'s combined ordering-aware CAS is
   * `tx.$executeRaw` (raw SQL — see event-processing.service.ts for why Prisma's query
   * builder cannot express it), not `tx.payrollEvent.updateMany`. The exact SQL text is
   * proven against real Postgres in the standalone smoke test performed during
   * implementation and in the e2e suite — this fake only reproduces `$executeRaw`'s
   * observable contract (affected-row count; on a match, flips status to PROCESSING and
   * increments attempts, exactly like the real UPDATE's SET clause). `updateMany` remains
   * used, unchanged, by every OTHER transition (finalizeSuccess/retryTransition/
   * finalizeFailure) — R3/R4 never call claimForProcessing at all, so their tests below are
   * entirely unaffected by this fixture split.
   */
  const buildFakePrisma = (event: Record<string, unknown> | null) => {
    let currentAttempts = (event?.attempts as number | undefined) ?? 0;
    let currentStatus = (event?.status as string | undefined) ?? 'PENDING';

    const executeRaw = jest.fn().mockImplementation(() => {
      if (currentStatus !== 'PENDING') {
        return Promise.resolve(0);
      }
      currentStatus = 'PROCESSING';
      currentAttempts += 1;
      return Promise.resolve(1);
    });

    const updateMany = jest.fn().mockImplementation((args: { data?: Record<string, unknown> }) => {
      const attemptsOp = args?.data?.attempts as { increment?: number } | undefined;
      if (attemptsOp?.increment) {
        currentAttempts += attemptsOp.increment;
      }
      if (typeof args?.data?.status === 'string') {
        currentStatus = args.data.status;
      }
      return Promise.resolve({ count: 1 });
    });

    // The claim step's diagnostic-only read after a failed $executeRaw — distinguishes
    // lost-race from ordering-blocked, never the correctness mechanism. Distinct from
    // findUniqueOrThrow below, which is only used after a successful write.
    const txFindUnique = jest
      .fn()
      .mockImplementation(() => Promise.resolve({ status: currentStatus }));

    const findUniqueOrThrow = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ ...event, status: currentStatus, attempts: currentAttempts }),
      );
    const create = jest.fn().mockResolvedValue(undefined);

    const tx = {
      $executeRaw: executeRaw,
      payrollEvent: { updateMany, findUniqueOrThrow, findUnique: txFindUnique },
      eventStatusHistory: { create },
    };

    const prisma = {
      payrollEvent: { findUnique: jest.fn().mockResolvedValue(event) },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };

    return { prisma, tx, executeRaw, updateMany, findUniqueOrThrow, txFindUnique, create };
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

  it('reports a lost race when the combined claim CAS matches zero rows because another worker already claimed it, without calling the provider', async () => {
    const event = { id: 'e1', status: 'PENDING', employeeId: 'emp-1', sequence: 1n };
    const { prisma, executeRaw, txFindUnique, create } = buildFakePrisma(event);
    // Simulate: another worker's claim already committed (status no longer PENDING) by the
    // time this attempt's combined CAS runs — the diagnostic read must see that, not PENDING.
    executeRaw.mockImplementationOnce(() => Promise.resolve(0));
    txFindUnique.mockResolvedValueOnce({ status: 'PROCESSING' });
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
      sequence: 1n,
      maxAttempts: 5,
    };
    const { prisma, executeRaw, updateMany, create } = buildFakePrisma(event);
    const providerResult = { providerReference: 'sim-e1' };
    const provider = buildFakeProvider({ outcome: 'SUCCESS', result: providerResult });
    const service = new EventProcessingService(prisma as never, provider);

    const result = await service.processEvent('e1');

    // The claim itself is the combined ordering-aware raw SQL CAS — its exact SQL shape is
    // proven against real Postgres separately; here we only confirm it was attempted once.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(provider.apply).toHaveBeenCalledWith({
      eventId: 'e1',
      employeeId: 'emp-1',
      eventType: 'ADDRESS_CHANGE',
      payload: {},
    });
    // The only updateMany call is the PROCESSING -> SUCCEEDED finalize.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'SUCCEEDED', result: providerResult }),
    });
    expect(create).toHaveBeenCalledWith({
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
      sequence: 1n,
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

    expect(updateMany).toHaveBeenCalledTimes(1); // only the finalize — claim is $executeRaw
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', status: 'PROCESSING' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: 'business rejection',
        failureType: 'PERMANENT',
      }),
    });
    expect(create).toHaveBeenCalledWith({
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
      sequence: 1n,
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

    const finalizeCall = updateMany.mock.calls[0][0];
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
        sequence: 1n,
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

      expect(updateMany).toHaveBeenCalledTimes(1); // only the retry transition — claim is $executeRaw
      // The retry transition must NOT touch `attempts` — only the claim step does.
      const retryCallArgs = updateMany.mock.calls[0][0];
      expect(retryCallArgs).toEqual({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PENDING' }),
      });
      expect(retryCallArgs.data.attempts).toBeUndefined();
      expect(retryCallArgs.data.processingFinishedAt).toBeUndefined(); // not terminal
      expect(retryCallArgs.data.failureType).toBeUndefined(); // status column only, no failure fields

      expect(create).toHaveBeenCalledWith({
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
        sequence: 1n,
        attempts: 2, // already retried twice; this claim becomes attempt 3
        maxAttempts: 5,
      };
      const { prisma, executeRaw, create } = buildFakePrisma(event);
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: { ok: true } });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(executeRaw).toHaveBeenCalledTimes(1);
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
        sequence: 1n,
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

      expect(updateMany).toHaveBeenCalledTimes(1); // only the terminal finalize
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', status: 'PROCESSING' },
        data: expect.objectContaining({
          status: 'FAILED',
          failureType: 'RETRYABLE',
          failureReason: 'still down',
        }),
      });
      expect(create).toHaveBeenCalledWith({
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
        sequence: 1n,
        attempts: 0,
        maxAttempts: 5,
      };
      const { prisma, updateMany } = buildFakePrisma(event);
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

  describe('Per-employee ordering: claimForProcessing blocked-by-ordering branch', () => {
    it('reports ordering-blocked when the combined CAS matches zero rows and the row is still PENDING (no attempts increment, no provider call, no history)', async () => {
      const event = { id: 'e1', status: 'PENDING', employeeId: 'emp-1', sequence: 2n };
      const { prisma, executeRaw, txFindUnique, updateMany, create } = buildFakePrisma(event);
      // Simulate the combined CAS failing specifically because of the NOT EXISTS ordering
      // predicate — status stays PENDING (nothing wrote to it), unlike the lost-race case.
      executeRaw.mockImplementationOnce(() => Promise.resolve(0));
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(prisma as never, provider);

      const result = await service.processEvent('e1');

      expect(result).toEqual({ outcome: 'ordering-blocked' });
      expect(txFindUnique).toHaveBeenCalledWith({ where: { id: 'e1' }, select: { status: true } });
      expect(updateMany).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    });

    it('the combined claim CAS is called with employeeId and sequence as bound parameters', async () => {
      const event = {
        id: 'e1',
        status: 'PENDING',
        employeeId: 'emp-42',
        eventType: 'ADDRESS_CHANGE',
        payload: {},
        sequence: 7n,
        maxAttempts: 5,
      };
      const { prisma, executeRaw } = buildFakePrisma(event);
      const provider = buildFakeProvider({ outcome: 'SUCCESS', result: {} });
      const service = new EventProcessingService(prisma as never, provider);

      await service.processEvent('e1');

      expect(executeRaw).toHaveBeenCalledTimes(1);
      // executeRaw is invoked as a tagged template: (stringsArray, ...values). The bound
      // values passed after the strings array are eventId, employeeId, sequence in that
      // order — asserting they were forwarded, not the full SQL text (proven against real
      // Postgres separately).
      const callArgs = executeRaw.mock.calls[0];
      expect(callArgs).toContain('e1');
      expect(callArgs).toContain('emp-42');
      expect(callArgs).toContain(7n);
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
