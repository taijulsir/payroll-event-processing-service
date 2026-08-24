import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { WorkerProcessingModule } from './processing/worker-processing.module';

/**
 * The worker entrypoint (architecture.md §5/§20/§26, database-design.md §12). A second
 * runtime entrypoint alongside main.ts, sharing the same AppModule composition of feature
 * modules (Prisma, Events, Health) rather than duplicating the API's bootstrap — plus
 * WorkerProcessingModule, which is exclusive to this entrypoint and is what actually starts
 * consuming the payroll-events queue.
 *
 * No HTTP server is started here: `NestFactory.createApplicationContext()` builds the DI
 * container and runs lifecycle hooks without ever creating an HTTP adapter or calling
 * `.listen()`. AppModule's AppController/HealthModule HTTP controllers are harmlessly present
 * in the container but unreachable — there is no listener for them to be reachable through.
 *
 * A BullMQ `Worker` starts consuming jobs the moment it is constructed (unlike an HTTP
 * server, it needs no separate "start" call) — so simply having Nest build this module graph
 * is what puts the worker to work.
 */
@Module({
  imports: [AppModule, WorkerProcessingModule],
})
class WorkerModule {}

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  Logger.log('Worker started — consuming the payroll-events queue', 'Worker');
}

bootstrap();
