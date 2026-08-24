import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CONNECTION } from '../processing/processing.constants';
import { DependencyStatus, HealthResponseDto } from './health-response.dto';

/**
 * GET /health's dependency checks (architecture.md §5/§6/§14/§20: "Report Postgres/Redis
 * liveness"). Deliberately shallow — a single lightweight query/ping against each
 * dependency, not a deep application-level check of queue depth, replication lag, disk
 * space, etc. ("How deeply you check external dependencies is your design decision" —
 * assignment §Health Check). No new observability framework; just two `try/catch`es.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const status = postgres === 'up' && redis === 'up' ? 'ok' : 'degraded';
    return { status, dependencies: { postgres, redis } };
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
