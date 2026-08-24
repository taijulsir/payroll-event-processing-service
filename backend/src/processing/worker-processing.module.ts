import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ProcessingModule } from './processing.module';
import { EventProcessingService } from './event-processing.service';
import { payrollEventsWorkerProvider } from './payroll-events-worker.provider';
import { StaleProcessingSweepService } from './stale-processing-sweep.service';
import { PAYROLL_EVENTS_WORKER } from './processing.constants';
import { PAYROLL_PROVIDER } from './payroll-provider';
import { SimulatedPayrollProvider } from './simulated-payroll-provider';

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
 *
 * The simulated payroll provider (this phase) is registered here too, not in
 * ProcessingModule: it is exclusively a worker-processing concern — the API never invokes
 * it — and EventProcessingService depends on it only through the PAYROLL_PROVIDER interface
 * token, never on SimulatedPayrollProvider directly.
 *
 * StaleProcessingSweepService (retry/backoff design, R4) is registered here for the same
 * reason: crash recovery is exclusively a worker-side concern, and it needs
 * PayrollEventsQueueService (re-exported by ProcessingModule, already imported above) to
 * re-enqueue events it recovers — no second queue, no second connection.
 */
@Module({
  imports: [ProcessingModule],
  providers: [
    EventProcessingService,
    payrollEventsWorkerProvider,
    StaleProcessingSweepService,
    { provide: PAYROLL_PROVIDER, useClass: SimulatedPayrollProvider },
  ],
})
export class WorkerProcessingModule implements OnModuleDestroy {
  constructor(@Inject(PAYROLL_EVENTS_WORKER) private readonly worker: Worker) {}

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
