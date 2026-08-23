import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so any future feature module (EventsModule, ProcessingModule, HealthModule, ...)
 * can inject PrismaService without re-importing this module everywhere.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
