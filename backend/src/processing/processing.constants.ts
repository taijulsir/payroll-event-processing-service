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

/**
 * Retry/backoff design, R4 — approved decision: how old `processing_started_at` must be
 * before a PROCESSING event is considered stale/abandoned (e.g. its worker crashed) and
 * eligible for stale-processing-sweep.service.ts to recover it. No architecture/database
 * design document specifies this value; it was explicitly approved as 2 minutes (see the R4
 * design-decision record) given the simulated provider resolves near-instantly today, making
 * any real legitimate processing far shorter than this threshold.
 */
export const STALE_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Retry/backoff design, R4 — how often the stale-processing sweep runs. Architecture.md §15
 * specifies only the pattern ("run on worker startup and on a fixed interval") for its own,
 * different sweep, not a value; no scheduling dependency exists in this codebase, so a plain
 * `setInterval` is used (approved: no new dependency). 30 seconds keeps recovery latency well
 * under the 2-minute staleness threshold without polling Postgres excessively — this specific
 * number was not separately re-confirmed after the timeout was set to 2 minutes and should be
 * revisited if that trade-off (recovery latency vs. sweep frequency) needs tuning.
 */
export const STALE_PROCESSING_SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * Per-employee ordering design — approved decision: the fixed delay used when a job is
 * deferred because an earlier, non-terminal sibling event exists for the same employee
 * (architecture.md §12). This is NOT retry/backoff (PAYROLL_EVENTS_JOB_BACKOFF_BASE_DELAY_MS
 * above) — an ordering wait is not a processing failure, has no attempt budget to protect,
 * and therefore uses a short, fixed delay rather than an exponential curve: the wait is
 * expected to resolve quickly once the predecessor finishes, and the predecessor's own
 * lifecycle is already time-bounded by R2/R3/R4, so there is nothing here for backoff growth
 * to protect against. No architecture/database-design document specifies this value.
 */
export const ORDERING_DEFER_DELAY_MS = 500;

/**
 * Reconciliation design (architecture.md §15, database-design.md §14) — the DB-commit →
 * queue-enqueue gap sweep. How old a `PENDING` event's `submitted_at` must be before it is
 * considered an orphan candidate (no corresponding BullMQ job) rather than simply a
 * just-submitted event whose normal, synchronous post-commit `enqueue()` call hasn't happened
 * yet. database-design.md §18's own worked SQL example for this exact query uses `interval
 * '5 minutes'` — adopted here as the approved concrete value (explicitly confirmed, not
 * silently invented, since architecture.md itself only says "a short threshold" without a
 * number). Deliberately much larger than `ORDERING_DEFER_DELAY_MS`/backoff-scale delays: this
 * threshold exists purely to avoid racing the normal synchronous enqueue-after-commit path
 * (architecture.md §17), not to bound anything time-sensitive.
 */
export const RECONCILIATION_AGE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Reconciliation design — how often the sweep re-runs after its initial on-startup pass
 * (architecture.md §15: "run on worker startup and on a fixed interval"). No document
 * specifies a number; explicitly approved as 60 seconds — comfortably under
 * `RECONCILIATION_AGE_THRESHOLD_MS` so an orphaned event is caught promptly without polling
 * excessively, and independent of `STALE_PROCESSING_SWEEP_INTERVAL_MS` above (a different
 * sweep, for a different gap — see `ReconciliationSweepService`'s own doc comment).
 */
export const RECONCILIATION_SWEEP_INTERVAL_MS = 60 * 1000;
