import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Worker, type Job, type Queue } from 'bullmq';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYROLL_EVENTS_QUEUE,
  PAYROLL_EVENTS_QUEUE_NAME,
  REDIS_CONNECTION,
  ORDERING_DEFER_DELAY_MS,
} from '../src/processing/processing.constants';
import { createPayrollEventProcessor } from '../src/processing/payroll-event-processor';
import { EventProcessingService } from '../src/processing/event-processing.service';
import { StaleProcessingSweepService } from '../src/processing/stale-processing-sweep.service';
import { PayrollEventsQueueService } from '../src/processing/payroll-events-queue.service';
import {
  SimulatedPayrollProvider,
  FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER,
} from '../src/processing/simulated-payroll-provider';
import type { PayrollProvider, PayrollProviderOutcome } from '../src/processing/payroll-provider';

/**
 * Per-employee ordering (architecture.md §12), approved design — verified against real
 * PostgreSQL AND real Redis/BullMQ.
 *
 * Mirrors the R1-R4 e2e suites' own conventions exactly: `EventProcessingService` (and, where
 * needed, `StaleProcessingSweepService`) constructed directly rather than resolved from the
 * Nest DI container, so private/internal methods (`claimForProcessing`'s ordering predicate)
 * are exercised through the same public surface a real worker uses (`processEvent`), while
 * still allowing deterministic, non-sleep-based control over which scenario runs. A handful of
 * scenarios that specifically need to prove real BullMQ behavior (`moveToDelayed`, no `'failed'`
 * emission, `job.attemptsMade` staying 0) run through an actual `bullmq.Worker` instead.
 */
describe('Per-employee ordering (architecture.md §12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let queue: Queue;
  let eventProcessingService: EventProcessingService;
  let queueService: PayrollEventsQueueService;
  let sweepService: StaleProcessingSweepService;

  const runPrefix = `ordering-test-${randomUUID()}`;
  const employeeId = (suffix: string) => `${runPrefix}-emp-${suffix}`;

  const seedEvent = (
    employeeIdValue: string,
    sequence: number,
    overrides: Partial<Record<string, unknown>> = {},
  ) =>
    prisma.payrollEvent.create({
      data: {
        employeeId: employeeIdValue,
        eventType: 'ADDRESS_CHANGE',
        sequence,
        idempotencyKey: `${runPrefix}-idem-${randomUUID()}`,
        payload: { effectiveDate: '2026-01-01', street: `${sequence} Example Street` },
        status: 'PENDING',
        maxAttempts: 5,
        ...overrides,
      },
    });

  const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitUntil: condition not met within timeout');
  };

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
    redis = app.get(REDIS_CONNECTION);
    queue = app.get(PAYROLL_EVENTS_QUEUE);
    queueService = app.get(PayrollEventsQueueService);
    eventProcessingService = new EventProcessingService(prisma, new SimulatedPayrollProvider());
    sweepService = new StaleProcessingSweepService(prisma, eventProcessingService, queueService);
  });

  afterAll(async () => {
    await prisma.eventStatusHistory.deleteMany({
      where: { event: { employeeId: { startsWith: runPrefix } } },
    });
    await prisma.payrollEvent.deleteMany({ where: { employeeId: { startsWith: runPrefix } } });
    await app.close();
  });

  describe('A. Sequence 1 (no predecessor)', () => {
    it('a first-sequence event claims immediately — NOT EXISTS is vacuously satisfied', async () => {
      const emp = employeeId(`seq1-${randomUUID()}`);
      const event = await seedEvent(emp, 1);

      const result = await eventProcessingService.processEvent(event.id);

      expect(result.outcome).toBe('succeeded');
    });
  });

  describe('B. Blocked by a non-terminal predecessor', () => {
    it('sequence 2 is blocked while sequence 1 is PENDING', async () => {
      const emp = employeeId(`pending-pred-${randomUUID()}`);
      await seedEvent(emp, 1); // predecessor stays PENDING, never processed
      const successor = await seedEvent(emp, 2);

      const result = await eventProcessingService.processEvent(successor.id);

      expect(result.outcome).toBe('ordering-blocked');
      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: successor.id } });
      expect(after.status).toBe('PENDING'); // untouched
      expect(after.attempts).toBe(0); // proves attempts is not consumed by a blocked attempt
    });

    it('sequence 2 is blocked while sequence 1 is PROCESSING', async () => {
      const emp = employeeId(`processing-pred-${randomUUID()}`);
      await seedEvent(emp, 1, { status: 'PROCESSING', processingStartedAt: new Date() });
      const successor = await seedEvent(emp, 2);

      const result = await eventProcessingService.processEvent(successor.id);

      expect(result.outcome).toBe('ordering-blocked');
      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: successor.id } });
      expect(after.status).toBe('PENDING');
      expect(after.attempts).toBe(0);
    });

    it('a blocked claim never invokes the provider', async () => {
      const emp = employeeId(`no-provider-call-${randomUUID()}`);
      await seedEvent(emp, 1); // PENDING predecessor
      const successor = await seedEvent(emp, 2);

      let applyCalls = 0;
      const countingProvider: PayrollProvider = {
        apply: async (input): Promise<PayrollProviderOutcome> => {
          applyCalls += 1;
          return new SimulatedPayrollProvider().apply(input);
        },
      };
      const service = new EventProcessingService(prisma, countingProvider);

      const result = await service.processEvent(successor.id);

      expect(result.outcome).toBe('ordering-blocked');
      expect(applyCalls).toBe(0);
    });
  });

  describe('C. Terminal predecessors unblock the successor', () => {
    it('a SUCCEEDED predecessor unblocks its successor', async () => {
      const emp = employeeId(`succeeded-pred-${randomUUID()}`);
      const predecessor = await seedEvent(emp, 1);
      const successor = await seedEvent(emp, 2);

      const predecessorResult = await eventProcessingService.processEvent(predecessor.id);
      expect(predecessorResult.outcome).toBe('succeeded');

      const successorResult = await eventProcessingService.processEvent(successor.id);
      expect(successorResult.outcome).toBe('succeeded');
    });

    it('a FAILED (PERMANENT) predecessor unblocks its successor — FAILED is terminal, not "skipped"', async () => {
      // The deterministic-failure marker is keyed off employeeId (simulated-payroll-provider.ts),
      // so both sibling events for this employee will deterministically FAIL too — that's fine:
      // the property under test is that the successor gets to ATTEMPT at all (is no longer
      // ordering-blocked) once its FAILED predecessor is terminal, not that it succeeds.
      const emp = employeeId(`FORCE_PROVIDER_FAILURE-failed-pred-${randomUUID()}`);
      const predecessor = await seedEvent(emp, 1);
      const successor = await seedEvent(emp, 2);

      const predecessorResult = await eventProcessingService.processEvent(predecessor.id);
      expect(predecessorResult.outcome).toBe('failed');

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: predecessor.id } });
      expect(after.status).toBe('FAILED');

      const successorResult = await eventProcessingService.processEvent(successor.id);
      // Not 'ordering-blocked': the FAILED predecessor unblocked the claim, so the successor
      // reached the provider and got its own (also deterministically FAILED) terminal outcome —
      // there is no third "skipped" status.
      expect(successorResult.outcome).toBe('failed');
      const successorAfter = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: successor.id },
      });
      expect(successorAfter.status).toBe('FAILED');
      expect(successorAfter.attempts).toBe(1); // it WAS claimed and attempted, not silently skipped
    });
  });

  describe('D. Retry interaction (R2)', () => {
    it('retrying predecessor (transient failure, PROCESSING -> PENDING) keeps the successor blocked', async () => {
      const emp = employeeId(
        `${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}-retry-pred-${randomUUID()}`,
      );
      const predecessor = await seedEvent(emp, 1);
      const successor = await seedEvent(emp, 2);

      const predecessorResult = await eventProcessingService.processEvent(predecessor.id);
      expect(predecessorResult.outcome).toBe('retry-scheduled'); // TRANSIENT, budget remains

      const predecessorAfter = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: predecessor.id },
      });
      expect(predecessorAfter.status).toBe('PENDING'); // non-terminal
      expect(predecessorAfter.attempts).toBe(1);

      const successorResult = await eventProcessingService.processEvent(successor.id);
      expect(successorResult.outcome).toBe('ordering-blocked');
      const successorAfter = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: successor.id },
      });
      expect(successorAfter.attempts).toBe(0); // blocked attempt never consumed event.attempts
    });
  });

  describe('E. R4 interaction (stale-processing recovery)', () => {
    it('recovering a stale-PROCESSING predecessor eventually unblocks the successor', async () => {
      const emp = employeeId(`r4-recovery-pred-${randomUUID()}`);
      const predecessor = await seedEvent(emp, 1, {
        status: 'PROCESSING',
        processingStartedAt: new Date(Date.now() - 3 * 60 * 1000), // safely past the staleness threshold
        attempts: 1,
      });
      const successor = await seedEvent(emp, 2);

      // Before recovery: successor is correctly blocked (predecessor is PROCESSING, non-terminal).
      const blockedResult = await eventProcessingService.processEvent(successor.id);
      expect(blockedResult.outcome).toBe('ordering-blocked');

      // R4 must not misclassify the blocked successor as the stale candidate — only the
      // predecessor (actually PROCESSING past the threshold) is recovered.
      await sweepService.runSweep();

      const predecessorAfter = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: predecessor.id },
      });
      expect(predecessorAfter.status).toBe('PENDING'); // recovered, non-terminal but reclaimable

      // Predecessor is still non-terminal (PENDING) immediately after recovery — successor
      // stays blocked until the predecessor is actually claimed and finalized.
      const stillBlockedResult = await eventProcessingService.processEvent(successor.id);
      expect(stillBlockedResult.outcome).toBe('ordering-blocked');

      // Now let the predecessor actually run to a terminal state (simulating the real worker
      // reclaiming it) — this is what "eventually unblocks" means end to end.
      const predecessorFinal = await eventProcessingService.processEvent(predecessor.id);
      expect(predecessorFinal.outcome).toBe('succeeded');

      const successorFinal = await eventProcessingService.processEvent(successor.id);
      expect(successorFinal.outcome).toBe('succeeded');
    });
  });

  describe('F. Cross-employee concurrency', () => {
    it('different employees are never blocked by each other', async () => {
      const empA = employeeId(`concurrent-a-${randomUUID()}`);
      const empB = employeeId(`concurrent-b-${randomUUID()}`);
      // Employee A has a stuck, non-terminal sequence-1 predecessor — A's own sequence 2 would
      // be blocked, but this must never affect employee B at all.
      await seedEvent(empA, 1, { status: 'PROCESSING', processingStartedAt: new Date() });
      const aSuccessor = await seedEvent(empA, 2);
      const bFirst = await seedEvent(empB, 1);

      const [aResult, bResult] = await Promise.all([
        eventProcessingService.processEvent(aSuccessor.id),
        eventProcessingService.processEvent(bFirst.id),
      ]);

      expect(aResult.outcome).toBe('ordering-blocked');
      expect(bResult.outcome).toBe('succeeded'); // unaffected by employee A's blocked chain
    });
  });

  describe('G. Duplicate / redelivered claims stay safe', () => {
    it('repeatedly re-attempting a blocked claim is idempotent: no duplicate history, no attempts drift', async () => {
      const emp = employeeId(`dup-blocked-${randomUUID()}`);
      await seedEvent(emp, 1); // PENDING predecessor, never resolved
      const successor = await seedEvent(emp, 2);

      const results = await Promise.all([
        eventProcessingService.processEvent(successor.id),
        eventProcessingService.processEvent(successor.id),
        eventProcessingService.processEvent(successor.id),
      ]);

      expect(results.every((r) => r.outcome === 'ordering-blocked')).toBe(true);

      const after = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: successor.id } });
      expect(after.status).toBe('PENDING');
      expect(after.attempts).toBe(0);

      const history = await prisma.eventStatusHistory.count({ where: { eventId: successor.id } });
      expect(history).toBe(0); // a blocked claim never writes a history row
    });

    it('a claim that legitimately loses the race (not ordering-blocked) is still distinguished correctly', async () => {
      const emp = employeeId(`lost-race-${randomUUID()}`);
      const event = await seedEvent(emp, 1); // no predecessor — sequence 1 is never ordering-blocked

      const [first, second] = await Promise.all([
        eventProcessingService.processEvent(event.id),
        eventProcessingService.processEvent(event.id),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      // Exactly one call wins the claim (and proceeds to a terminal outcome); the other loses
      // the race — never both "ordering-blocked" (there is no predecessor here to block on).
      expect(outcomes).toContain('succeeded');
      expect(outcomes.filter((o) => o === 'lost-race')).toHaveLength(1);
    });
  });

  describe('H. Real BullMQ: moveToDelayed / DelayedError mechanics', () => {
    it('a blocked job is deferred via moveToDelayed+DelayedError: attemptsMade stays 0 while blocked, no "failed" event, provider never invoked while blocked, and the job eventually completes once unblocked', async () => {
      const emp = employeeId(`real-worker-defer-${randomUUID()}`);
      const predecessor = await seedEvent(emp, 1);
      const successor = await seedEvent(emp, 2);

      // Keyed per-eventId (not a single global counter): the predecessor is deliberately
      // unblocked below via a direct `service.processEvent()` call using this SAME service
      // instance, so a single shared counter would conflate "the predecessor was invoked" with
      // "the successor was invoked" — the property under test is specifically that the
      // SUCCESSOR is invoked exactly once, only after it stops being ordering-blocked.
      const applyCallsByEventId = new Map<string, number>();
      const countingProvider: PayrollProvider = {
        apply: async (input): Promise<PayrollProviderOutcome> => {
          applyCallsByEventId.set(input.eventId, (applyCallsByEventId.get(input.eventId) ?? 0) + 1);
          return new SimulatedPayrollProvider().apply(input);
        },
      };
      const service = new EventProcessingService(prisma, countingProvider);

      const failedJobIds: string[] = [];
      const worker = new Worker(PAYROLL_EVENTS_QUEUE_NAME, createPayrollEventProcessor(service), {
        connection: redis,
        concurrency: 5,
      });
      worker.on('failed', (job) => {
        if (job) failedJobIds.push(job.id ?? '');
      });
      await worker.waitUntilReady();

      try {
        await queueService.enqueue(successor.id);

        // Give the worker time to pick up the job, get ordering-blocked, and move it to
        // delayed — confirmed via the job's own state rather than a fixed sleep.
        const job = await waitUntilJob(queue, successor.id);
        await waitUntil(async () => (await job.isDelayed()) === true, 4000);

        expect(await job.isFailed()).toBe(false);
        expect(job.attemptsMade).toBe(0); // the deferral never consumed BullMQ's own attempt budget
        expect(applyCallsByEventId.get(successor.id) ?? 0).toBe(0); // provider never reached while blocked

        // Unblock: let the predecessor reach a terminal state.
        const predecessorResult = await service.processEvent(predecessor.id);
        expect(predecessorResult.outcome).toBe('succeeded');

        // The deferred job is redelivered ORDERING_DEFER_DELAY_MS after it was blocked; once
        // redelivered it should now succeed.
        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: successor.id } });
          return e.status === 'SUCCEEDED';
        }, ORDERING_DEFER_DELAY_MS + 8000);

        expect(failedJobIds).not.toContain(successor.id); // BullMQ 'failed' never fired for the defer
        expect(applyCallsByEventId.get(successor.id)).toBe(1); // exactly one real provider invocation, once unblocked

        // `moveToCompleted` itself increments `attemptsMade` by 1 for ANY successful job,
        // deferred or not (verified against the installed BullMQ source) — this is the same
        // baseline test I's plain, never-blocked job ends at. The property this test actually
        // proves is the one already asserted above: attemptsMade stayed 0 for as long as the
        // job was ordering-blocked, i.e. the deferral itself never consumed attempt budget —
        // the eventual 1 here reflects one real completed attempt, not a retry.
        const finalJob = await queue.getJob(successor.id);
        expect(finalJob?.attemptsMade).toBe(1);
      } finally {
        await worker.close();
      }
    }, 20000);
  });

  describe('I. No regression: an unblocked job still processes normally through a real worker', () => {
    it('a real worker processes an unblocked, single-sequence event end to end', async () => {
      const emp = employeeId(`real-worker-normal-${randomUUID()}`);
      const event = await seedEvent(emp, 1);

      const worker = new Worker(
        PAYROLL_EVENTS_QUEUE_NAME,
        createPayrollEventProcessor(eventProcessingService),
        { connection: redis, concurrency: 5 },
      );
      await worker.waitUntilReady();

      try {
        await queueService.enqueue(event.id);

        await waitUntil(async () => {
          const e = await prisma.payrollEvent.findUniqueOrThrow({ where: { id: event.id } });
          return e.status === 'SUCCEEDED';
        });

        const job = await queue.getJob(event.id);
        expect(job?.attemptsMade).toBe(1);
      } finally {
        await worker.close();
      }
    });
  });
});

/** Polls the queue until the given job id is visible (guards against an add()/getJob() race). */
async function waitUntilJob(queue: Queue, jobId: string, timeoutMs = 4000): Promise<Job> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntilJob: job ${jobId} not found within timeout`);
}
