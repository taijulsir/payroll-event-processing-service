import { createPayrollEventProcessor } from './payroll-event-processor';
import type { EventProcessingService } from './event-processing.service';

describe('createPayrollEventProcessor', () => {
  const buildJob = (data: unknown, id = 'job-1') => ({ id, data }) as never;

  it('delegates to EventProcessingService.processEvent with the job data eventId', async () => {
    const processEvent = jest.fn().mockResolvedValue({ outcome: 'claimed' });
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

  it.each(['succeeded', 'failed', 'terminal', 'already-processing', 'lost-race', 'missing'])(
    'does not throw for the non-retry outcome %s',
    async (outcome) => {
      const processEvent = jest.fn().mockResolvedValue({ outcome });
      const service = { processEvent } as unknown as EventProcessingService;
      const processor = createPayrollEventProcessor(service);

      await expect(processor(buildJob({ eventId: 'event-123' }))).resolves.toBeUndefined();
    },
  );
});
