/**
 * Types mirroring the actual backend response/request shapes exactly, as read from the
 * source of truth (not guessed):
 *   backend/src/events/dto/event-response.dto.ts
 *   backend/src/events/dto/event-detail-response.dto.ts
 *   backend/src/events/dto/event-status-history.dto.ts
 *   backend/src/events/dto/list-events-response.dto.ts
 *   backend/src/events/dto/list-events-query.dto.ts
 *   backend/src/event-types/*.dto.ts
 *   backend/src/health/health-response.dto.ts
 */

export const EVENT_TYPES = ['BANK_ACCOUNT_CHANGE', 'ADDRESS_CHANGE', 'SALARY_CHANGE'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export type FailureType = 'RETRYABLE' | 'PERMANENT' | null;

/** Matches EventResponseDto — the shape returned by POST /events and each item of GET /events. */
export interface PayrollEvent {
  id: string;
  employeeId: string;
  eventType: string;
  /** bigint on the backend, serialized as a decimal string to avoid precision loss. */
  sequence: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  result: unknown | null;
  failureReason: string | null;
  failureType: string | null;
  submittedAt: string;
  processingStartedAt: string | null;
  processingFinishedAt: string | null;
}

/** Matches EventStatusHistoryEntryDto. */
export interface EventStatusHistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  occurredAt: string;
  attemptNumber: number | null;
  errorMessage: string | null;
}

/** Matches EventDetailResponseDto — GET /events/:id. */
export interface PayrollEventDetail extends PayrollEvent {
  statusHistory: EventStatusHistoryEntry[];
}

/** Matches ListEventsResponseDto — GET /events. */
export interface ListEventsResponse {
  items: PayrollEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListEventsParams {
  employeeId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** Matches HealthResponseDto — GET /health. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  dependencies: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

// --- Submission payloads --------------------------------------------------
// Field sets match the actual backend DTOs exactly (backend/src/event-types/*.dto.ts), not
// the assignment brief's example field lists, which the backend DTOs already match anyway.

export interface BankAccountChangeInput {
  eventType: 'BANK_ACCOUNT_CHANGE';
  employeeId: string;
  effectiveDate: string;
  iban: string;
}

export interface AddressChangeInput {
  eventType: 'ADDRESS_CHANGE';
  employeeId: string;
  effectiveDate: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface SalaryChangeInput {
  eventType: 'SALARY_CHANGE';
  employeeId: string;
  effectiveDate: string;
  newSalary: number;
  currency: string;
}

export type SubmitEventInput = BankAccountChangeInput | AddressChangeInput | SalaryChangeInput;
