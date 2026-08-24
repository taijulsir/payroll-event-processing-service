import { Logger, Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from './processing.constants';

/**
 * The single shared ioredis connection this process uses for BullMQ (and, via
 * REDIS_CONNECTION, for the health check's liveness ping). Configuration comes entirely
 * from environment variables (REDIS_HOST/REDIS_PORT, already documented in .env.example
 * since Phase 1) — no hardcoded host, port, or credentials. No password/ACL is configured
 * because none exists on the local Redis instance (docker-compose.yml); if a deployment
 * ever needs one, it belongs here as an additional env var, not hardcoded.
 *
 * `maxRetriesPerRequest: null` is BullMQ's documented requirement for connections used by a
 * Worker (its blocking commands would otherwise be prematurely abandoned on transient
 * errors). No Worker exists yet in this phase, but setting it now costs nothing and means
 * this exact connection can be reused as-is once one is added.
 */
export const redisConnectionProvider: Provider = {
  provide: REDIS_CONNECTION,
  useFactory: (): Redis => {
    const logger = new Logger('RedisConnection');
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;

    const connection = new Redis({
      host,
      port,
      maxRetriesPerRequest: null,
    });

    connection.on('connect', () => logger.log(`Connected to Redis at ${host}:${port}`));
    connection.on('error', (err) => logger.error(`Redis connection error: ${err.message}`));

    return connection;
  },
};
