/**
 * The abstraction the worker's processing logic depends on, standing in for whatever a real
 * external payroll system would eventually be (architecture.md §16 — explicitly simulated,
 * never a real integration in this assignment). `EventProcessingService` depends on this
 * interface, not on any concrete simulation logic, so the simulation implementation can be
 * swapped out (e.g. for a test double) without EventProcessingService itself changing.
 */
export interface PayrollProviderInput {
  eventId: string;
  employeeId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface PayrollProviderSuccess {
  outcome: 'SUCCESS';
  /** Persisted verbatim into `payroll_events.result` (database-design.md §4). */
  result: Record<string, unknown>;
}

export interface PayrollProviderFailure {
  outcome: 'FAILURE';
  /**
   * Whether this failure is worth retrying (architecture.md §13's two-code-path split:
   * `TransientProviderError` vs `PermanentProviderError`). This is the provider's own
   * classification of the failure it just produced — it does not, by itself, cause any
   * retry to happen. Retry/backoff and finalize (a later, dedicated increment) is what
   * actually acts on this value; as of this phase, every failure — regardless of this
   * field — is still finalized to FAILED/PERMANENT (see event-processing.service.ts).
   */
  classification: 'TRANSIENT' | 'PERMANENT';
  /** Persisted into `payroll_events.failure_reason` (database-design.md §4). */
  failureReason: string;
}

export type PayrollProviderOutcome = PayrollProviderSuccess | PayrollProviderFailure;

export interface PayrollProvider {
  apply(input: PayrollProviderInput): Promise<PayrollProviderOutcome>;
}

/** DI token — EventProcessingService injects against this interface, never a concrete class. */
export const PAYROLL_PROVIDER = Symbol('PAYROLL_PROVIDER');
