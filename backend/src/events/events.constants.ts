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
