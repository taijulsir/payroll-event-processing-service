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

/**
 * DI token for the BullMQ Worker instance that consumes `payroll-events` (this phase).
 * Provided only by WorkerProcessingModule, which is imported by worker.ts alone — never by
 * AppModule — so the API process never constructs a Worker and never starts consuming jobs.
 */
export const PAYROLL_EVENTS_WORKER = Symbol('PAYROLL_EVENTS_WORKER');

/**
 * BullMQ's own delivery-retry budget for `payroll-events` jobs (retry/backoff design, R2 —
 * approved decision: maxAttempts = 5). This is BullMQ's "how many times may this job be
 * delivered" counter (`job.opts.attempts` / `job.attemptsMade`), set once as a queue-wide
 * default via `payrollEventsQueueProvider`.
 *
 * It is deliberately the SAME number as `events.constants.ts`'s `DEFAULT_MAX_ATTEMPTS` today,
 * but the two are NOT the same field and are not guaranteed to stay in lockstep: this constant
 * bounds how many times BullMQ will ever hand this job to a processor; `payroll_events.attempts`
 * (compared against `payroll_events.max_attempts`, a per-event Postgres column) is what
 * `EventProcessingService` actually uses to decide whether a transient failure gets retried or
 * finalized — that decision is made BEFORE BullMQ's own budget would ever matter, so under
 * normal operation this queue-level limit is a backstop, never the primary decision-maker. See
 * event-processing.service.ts for the full explanation, including the crash/divergence case
 * where these two counters could disagree.
 */
export const PAYROLL_EVENTS_JOB_ATTEMPTS = 5;

/**
 * Base delay (ms) for BullMQ's exponential backoff between `payroll-events` redeliveries
 * (retry/backoff design, R2 — approved decision: 2 second base delay). Applied via
 * `payrollEventsQueueProvider`'s `defaultJobOptions.backoff`. No jitter — not required by the
 * approved design, and this assignment's scale has no thundering-herd scenario to justify it.
 */
export const PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS = 2000;
