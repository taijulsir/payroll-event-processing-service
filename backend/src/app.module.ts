import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import {
  EVENTS_SUBMIT_RATE_LIMIT,
  EVENTS_SUBMIT_RATE_LIMIT_WINDOW_MS,
} from './events/events.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    // Registered once, application-wide (ThrottlerModule is @Global()), but the guard itself
    // is attached only to POST /events (events.controller.ts) — every other route is
    // unaffected. See events.constants.ts for the limit/window rationale.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: EVENTS_SUBMIT_RATE_LIMIT_WINDOW_MS, limit: EVENTS_SUBMIT_RATE_LIMIT },
    ]),
    PrismaModule,
    EventsModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
