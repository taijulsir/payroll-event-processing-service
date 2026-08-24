import { Injectable } from '@nestjs/common';
import type {
  PayrollProvider,
  PayrollProviderInput,
  PayrollProviderOutcome,
} from './payroll-provider';

/**
 * Reserved substring: if present anywhere in `employeeId`, the provider deterministically
 * returns FAILURE; otherwise it deterministically returns SUCCESS.
 *
 * Why this mechanism (documented per this phase's explicit instruction): tests must be able
 * to force a specific outcome without relying on randomness (architecture.md §16/§18 both
 * require deterministic failure injection for automated tests — "must never depend on random
 * chance"). `employeeId` is the one field guaranteed present, and passed to the provider, for
 * every event type (unlike e.g. IBAN, which only BANK_ACCOUNT_CHANGE has) — keying the
 * marker off it needs no per-event-type special-casing and no new DTO/schema field. A test
 * simply chooses an `employeeId` containing this marker to deterministically force a
 * failure. This is the smallest mechanism that satisfies "demonstrate success and demonstrate
 * failure," per this phase's explicit instruction not to make it more complex than necessary.
 */
export const FORCE_PROVIDER_FAILURE_MARKER = 'FORCE_PROVIDER_FAILURE';

/**
 * The simulated external payroll provider (architecture.md §16). Deterministic — no
 * `Math.random()`, no network calls — so it is safe for automated tests and unit-testable in
 * isolation. Does not add artificial latency: nothing in this phase's scope calls for it, and
 * doing so would only work against "do not use timing-based tests for correctness."
 */
@Injectable()
export class SimulatedPayrollProvider implements PayrollProvider {
  async apply(input: PayrollProviderInput): Promise<PayrollProviderOutcome> {
    if (input.employeeId.includes(FORCE_PROVIDER_FAILURE_MARKER)) {
      return {
        outcome: 'FAILURE',
        failureReason: `Simulated payroll provider rejected event ${input.eventId} for employeeId '${input.employeeId}' (deterministic test marker matched).`,
      };
    }

    return {
      outcome: 'SUCCESS',
      result: {
        providerReference: `sim-${input.eventId}`,
        eventType: input.eventType,
        appliedAt: new Date().toISOString(),
      },
    };
  }
}
