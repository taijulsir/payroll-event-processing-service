import { createFailedJobBackstopHandler } from './payroll-event-failed-backstop';
import type { EventProcessingService } from './event-processing.service';

describe('createFailedJobBackstopHandler', () => {
  const buildJob = (
    overrides: Partial<{ id: string; data: unknown; attemptsMade: number; opts: unknown }> = {},
  ) =>
    ({
      id: 'job-1',
      data: { eventId: 'event-123' },
      attemptsMade: 5,
      opts: { attempts: 5 },
      ...overrides,
    }) as never;

  it('reconciles when the job is exhausted (attemptsMade >= opts.attempts)', async () => {
    const reconcileExhaustedJob = jest.fn().mockResolvedValue(true);
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await handler(buildJob({ attemptsMade: 5, opts: { attempts: 5 } }), new Error('boom'));

    expect(reconcileExhaustedJob).toHaveBeenCalledWith('event-123');
  });

  it('does NOT reconcile when retries remain (attemptsMade < opts.attempts)', async () => {
    const reconcileExhaustedJob = jest.fn();
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await handler(buildJob({ attemptsMade: 2, opts: { attempts: 5 } }), new Error('boom'));

    expect(reconcileExhaustedJob).not.toHaveBeenCalled();
  });

  it('treats attemptsMade exactly equal to opts.attempts as exhausted', async () => {
    const reconcileExhaustedJob = jest.fn().mockResolvedValue(true);
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await handler(buildJob({ attemptsMade: 3, opts: { attempts: 3 } }), new Error('boom'));

    expect(reconcileExhaustedJob).toHaveBeenCalledWith('event-123');
  });

  it('falls back to attempts=1 when opts.attempts is missing, and still detects exhaustion', async () => {
    const reconcileExhaustedJob = jest.fn().mockResolvedValue(true);
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await handler(buildJob({ attemptsMade: 1, opts: {} }), new Error('boom'));

    expect(reconcileExhaustedJob).toHaveBeenCalledWith('event-123');
  });

  it('does nothing when job is undefined (stalled/removed job — out of R3 scope)', async () => {
    const reconcileExhaustedJob = jest.fn();
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await expect(handler(undefined, new Error('stalled'))).resolves.toBeUndefined();
    expect(reconcileExhaustedJob).not.toHaveBeenCalled();
  });

  it('does nothing when job.data has no eventId (malformed job)', async () => {
    const reconcileExhaustedJob = jest.fn();
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await expect(
      handler(buildJob({ data: {}, attemptsMade: 5, opts: { attempts: 5 } }), new Error('boom')),
    ).resolves.toBeUndefined();
    expect(reconcileExhaustedJob).not.toHaveBeenCalled();
  });

  it('does not throw and does not crash the worker if reconcileExhaustedJob itself throws', async () => {
    const reconcileExhaustedJob = jest.fn().mockRejectedValue(new Error('db unreachable'));
    const service = { reconcileExhaustedJob } as unknown as EventProcessingService;
    const handler = createFailedJobBackstopHandler(service);

    await expect(
      handler(buildJob({ attemptsMade: 5, opts: { attempts: 5 } }), new Error('boom')),
    ).resolves.toBeUndefined();
  });
});
