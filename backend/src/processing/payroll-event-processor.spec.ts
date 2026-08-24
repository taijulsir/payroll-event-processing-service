import { DelayedError } from 'bullmq';
import { createPayrollEventProcessor } from './payroll-event-processor';
import type { EventProcessingService } from './event-processing.service';

describe('createPayrollEventProcessor', () => {
  const buildJob = (data: unknown, id = 'job-1') =>
    ({ id, data, moveToDelayed: jest.fn().mockResolvedValue(undefined) }) as never;

  it('delegates to EventProcessingService.processEvent with the job data eventId', async () => {
    const processEvent = jest.fn().mockResolvedValue({ outcome: 'succeeded' });
    const service = { processEvent } as unknown as EventProcessingService;
    const processor = createPayrollEventProcessor(service);

    await processor(buildJob({ eventId: 'event-123' }));

    expect(processEvent).toHaveBeenCalledWith('event-123');
  });

  it('throws (does not call processEvent) for a malformed job with no eventId', async () => {
    const processEvent = jest.fn();
    const service = { processEvent } as unknown as EventProcessingService;
    const processor = createPayrollEventProcessor(service);

    await expect(processor(buildJob({}))).rejects.toThrow(/missing or invalid eventId/);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('throws (does not call processEvent) when eventId is not a string', async () => {
    const processEvent = jest.fn();
    const service = { processEvent } as unknown as EventProcessingService;
    const processor = createPayrollEventProcessor(service);

    await expect(processor(buildJob({ eventId: 42 }))).rejects.toThrow();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected error from processEvent so BullMQ marks the job failed', async () => {
    const processEvent = jest.fn().mockRejectedValue(new Error('db exploded'));
    const service = { processEvent } as unknown as EventProcessingService;
    const processor = createPayrollEventProcessor(service);

    await expect(processor(buildJob({ eventId: 'event-123' }))).rejects.toThrow('db exploded');
  });

  it('R2: throws when processEvent reports retry-scheduled, so BullMQ redelivers via its own attempts/backoff', async () => {
    const processEvent = jest.fn().mockResolvedValue({ outcome: 'retry-scheduled' });
    const service = { processEvent } as unknown as EventProcessingService;
    const processor = createPayrollEventProcessor(service);

    await expect(processor(buildJob({ eventId: 'event-123' }))).rejects.toThrow(
      /scheduled for retry/,
    );
    expect(processEvent).toHaveBeenCalledWith('event-123');
  });

  describe('per-employee ordering: ordering-blocked outcome', () => {
    it('calls job.moveToDelayed(Date.now()+500, token) and throws DelayedError — never a plain Error', async () => {
      const processEvent = jest.fn().mockResolvedValue({ outcome: 'ordering-blocked' });
      const service = { processEvent } as unknown as EventProcessingService;
      const processor = createPayrollEventProcessor(service);
      const job = buildJob({ eventId: 'event-123' });
      const token = 'lock-token-abc';

      const before = Date.now();
      let thrown: unknown;
      try {
        await processor(job, token);
      } catch (err) {
        thrown = err;
      }
      const after = Date.now();

      expect(thrown).toBeInstanceOf(DelayedError);
      expect((job as { moveToDelayed: jest.Mock }).moveToDelayed).toHaveBeenCalledTimes(1);
      const [timestamp, passedToken] = (job as { moveToDelayed: jest.Mock }).moveToDelayed.mock
        .calls[0];
      expect(passedToken).toBe(token);
      // Fixed 500ms ordering-defer delay, not retry/backoff — allow a small scheduling window.
      expect(timestamp).toBeGreaterThanOrEqual(before + 500);
      expect(timestamp).toBeLessThanOrEqual(after + 500 + 50);
    });

    it('calls moveToDelayed before throwing (ordering matters: the job must already be in the delayed set)', async () => {
      const processEvent = jest.fn().mockResolvedValue({ outcome: 'ordering-blocked' });
      const service = { processEvent } as unknown as EventProcessingService;
      const processor = createPayrollEventProcessor(service);
      const job = buildJob({ eventId: 'event-123' });
      const moveToDelayedMock = (job as { moveToDelayed: jest.Mock }).moveToDelayed;
      let moveToDelayedCalledBeforeThrow = false;
      moveToDelayedMock.mockImplementation(() => {
        moveToDelayedCalledBeforeThrow = true;
        return Promise.resolve(undefined);
      });

      await expect(processor(job, 'token')).rejects.toBeInstanceOf(DelayedError);
      expect(moveToDelayedCalledBeforeThrow).toBe(true);
    });
  });

  it.each(['succeeded', 'failed', 'terminal', 'already-processing', 'lost-race', 'missing'])(
    'does not throw for the non-retry, non-ordering outcome %s',
    async (outcome) => {
      const processEvent = jest.fn().mockResolvedValue({ outcome });
      const service = { processEvent } as unknown as EventProcessingService;
      const processor = createPayrollEventProcessor(service);

      await expect(processor(buildJob({ eventId: 'event-123' }))).resolves.toBeUndefined();
    },
  );
});
