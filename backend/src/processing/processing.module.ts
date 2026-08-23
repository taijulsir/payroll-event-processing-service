import { Module } from '@nestjs/common';
import { redisConnectionProvider } from './redis-connection.provider';
import { payrollEventsQueueProvider } from './payroll-events-queue.provider';
import { PayrollEventsQueueService } from './payroll-events-queue.service';
import { REDIS_CONNECTION } from './processing.constants';

/**
 * Queue integration foundation (architecture.md §9, this phase). Contains only the queue
 * producer side: the Redis connection, the `payroll-events` BullMQ queue, and the narrow
 * service EventsModule uses to enqueue a job after its own transaction commits. No worker,
 * no processor, no provider simulation, no retry logic — those are later phases
 * (architecture.md §26, Phase 5+).
 *
 * Not @Global — EventsModule and HealthModule import it explicitly, matching how
 * EventsModule is itself structured (only PrismaModule is @Global, since the DB client is
 * needed almost everywhere; the queue is not).
 */
@Module({
  providers: [redisConnectionProvider, payrollEventsQueueProvider, PayrollEventsQueueService],
  exports: [PayrollEventsQueueService, REDIS_CONNECTION],
})
export class ProcessingModule {}
