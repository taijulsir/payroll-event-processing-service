import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin injectable wrapper around the generated Prisma Client — the database foundation
 * described in docs/database-design.md. This module intentionally contains no business
 * logic (no idempotency handling, no sequence allocation, no CAS transitions) — those are
 * introduced in their own implementation phases (see docs/architecture.md §26).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
