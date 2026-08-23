/**
 * The one BullMQ queue this system uses — architecture.md §9: "one queue, payroll-events —
 * not one per event type, not one per employee." Do not add a second queue; per-employee
 * ordering is enforced inside the (future) worker's processor, not by queue topology.
 */
export const PAYROLL_EVENTS_QUEUE_NAME = 'payroll-events';

/**
 * BullMQ job "name" (the type of work, not its identity — see JOB_ID below). This queue
 * only ever holds one kind of job, so a single constant is enough; a future event type does
 * not need a new job name, since the worker re-reads the authoritative event from Postgres
 * by `eventId` regardless of which event type it is (architecture.md §9).
 */
export const PROCESS_PAYROLL_EVENT_JOB_NAME = 'process-payroll-event';

/** DI token for the shared ioredis connection (also reused by HealthModule for its ping). */
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

/** DI token for the BullMQ Queue instance. */
export const PAYROLL_EVENTS_QUEUE = Symbol('PAYROLL_EVENTS_QUEUE');
