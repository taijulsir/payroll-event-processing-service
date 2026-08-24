/**
 * Attempt budget applied to every event at submission time.
 *
 * `max_attempts` has no database default by design (database-design.md §4: "the
 * application supplies it from config on every insert"). As of the retry/backoff design's R2
 * increment, this is no longer an inert placeholder: `EventProcessingService` reads each
 * event's own `maxAttempts` column and compares it against `attempts` to decide whether a
 * transient provider failure gets retried or finalized (database-design.md §4's own
 * definition of `attempts`: "incremented on each PENDING -> PROCESSING claim"). The concrete
 * value (5, an approved decision) matches `PAYROLL_EVENTS_JOB_ATTEMPTS`
 * (processing.constants.ts) — see that constant's comment for why the two are related but not
 * the same field.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * `POST /events` rate limiting (production-appropriate abuse protection, not a business rule —
 * does not affect retry/backoff/ordering/reconciliation, which are entirely separate
 * mechanisms further down the pipeline). Applied only to event submission, not to the read
 * endpoints (`GET /events`, `GET /events/:id`) or `/health` — see events.controller.ts.
 *
 * 60 requests per rolling 60-second window per client IP: generous enough for legitimate
 * bursts (a client retrying a flaky connection, a small batch import) — comfortably above the
 * largest concurrent-submission burst this codebase's own e2e suite issues in one test file
 * (events-submission.e2e-spec.ts, ~36 requests including its own 8-way and 10-way concurrent
 * bursts) — while still bounding a scripted flood. Revisit if real traffic patterns differ.
 */
export const EVENTS_SUBMIT_RATE_LIMIT = 60;
export const EVENTS_SUBMIT_RATE_LIMIT_WINDOW_MS = 60_000;
