/**
 * Attempt budget applied to every event at submission time.
 *
 * `max_attempts` has no database default by design (database-design.md §4: "the
 * application supplies it from config on every insert") — the concrete number and the
 * retry/backoff curve are explicitly left to Phase 5 (architecture.md §13: "implementation
 * details of Phase 5, not architectural decisions themselves"). This constant is a
 * placeholder needed only to satisfy the NOT NULL column today; it is not itself an
 * architectural decision and should be revisited (likely made configurable via env, per
 * the PROVIDER_* pattern already in .env.example) when Phase 5 designs retry/backoff.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;
