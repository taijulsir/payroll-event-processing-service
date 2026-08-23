import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ProcessingModule } from '../processing/processing.module';

// PrismaModule is @Global; ProcessingModule (for REDIS_CONNECTION) is imported explicitly,
// same as EventsModule.
@Module({
  imports: [ProcessingModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
