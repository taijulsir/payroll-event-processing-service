import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

// PrismaModule is @Global (see ../prisma/prisma.module.ts) so PrismaService is injectable
// here without importing it explicitly.
@Module({
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
