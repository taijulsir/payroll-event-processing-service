import { PayrollEventsQueueService } from './payroll-events-queue.service';
import { PROCESS_PAYROLL_EVENT_JOB_NAME } from './processing.constants';

describe('PayrollEventsQueueService', () => {
  it('enqueues a job named PROCESS_PAYROLL_EVENT_JOB_NAME with jobId = eventId and a minimal payload', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const fakeQueue = { add, close: jest.fn() } as never;
    const fakeConnection = { quit: jest.fn() } as never;

    const service = new PayrollEventsQueueService(fakeQueue, fakeConnection);
    await service.enqueue('event-123');

    expect(add).toHaveBeenCalledWith(
      PROCESS_PAYROLL_EVENT_JOB_NAME,
      { eventId: 'event-123' },
      { jobId: 'event-123' },
    );
  });

  it('closes the queue and quits the Redis connection on module destroy', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const quit = jest.fn().mockResolvedValue(undefined);
    const fakeQueue = { add: jest.fn(), close } as never;
    const fakeConnection = { quit } as never;

    const service = new PayrollEventsQueueService(fakeQueue, fakeConnection);
    await service.onModuleDestroy();

    expect(close).toHaveBeenCalled();
    expect(quit).toHaveBeenCalled();
  });
});
