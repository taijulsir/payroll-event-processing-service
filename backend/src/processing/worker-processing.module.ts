import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ProcessingModule } from './processing.module';
import { EventProcessingService } from './event-processing.service';
import { payrollEventsWorkerProvider } from './payroll-events-worker.provider';
import { PAYROLL_EVENTS_WORKER } from './processing.constants';

/**
 * The worker-only half of "processing" (this phase). Deliberately a module of its own,
 * separate from ProcessingModule: ProcessingModule is imported by EventsModule/HealthModule,
 * which are in turn part of AppModule — the same module graph `main.ts` (the API) bootstraps.
 * If the BullMQ Worker provider lived in ProcessingModule itself, the API process would
 * construct one too (Nest instantiates every provider in the bootstrapped graph) and would
 * start consuming payroll-events jobs alongside the worker — exactly what architecture.md's
 * "API and worker are separate runtime entrypoints" is meant to prevent.
 *
 * WorkerProcessingModule imports ProcessingModule to reuse its REDIS_CONNECTION and queue
 * name/job name constants (no second connection, no second queue), and is imported only by
 * worker.ts's bootstrap module — never by AppModule.
 */
@Module({
  imports: [ProcessingModule],
  providers: [EventProcessingService, payrollEventsWorkerProvider],
})
export class WorkerProcessingModule implements OnModuleDestroy {
  constructor(@Inject(PAYROLL_EVENTS_WORKER) private readonly worker: Worker) {}

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
