import type {
  HealthResponse,
  ListEventsParams,
  ListEventsResponse,
  PayrollEvent,
  PayrollEventDetail,
  SubmitEventInput,
} from './types';

/**
 * The single source of truth for where the backend API lives. Baked in at build time
 * (Next.js `NEXT_PUBLIC_*` env vars are inlined into the static export, matching this
 * frontend's "small static build" architecture — there is no server at runtime to read this
 * from `process.env` on each request). Defaults to `http://localhost:3000`, matching the
 * backend's own default port (backend/.env.example's `PORT=3000`, and docker-compose.yml's
 * `api` service publishing `${API_PORT:-3000}:3000` to the host) — this is deliberately a
 * browser-reachable host address, never a Compose-internal service name like `http://api:3000`
 * (that hostname only resolves between containers on the Compose network, not from the
 * user's browser, which is where this code actually runs — this app is a static export with
 * no server-side fetching).
 */
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

/**
 * Uniform error shape for every failure mode a component needs to render: a validation
 * rejection (400), a conflict (409), a missing resource (404), a genuine server error (500),
 * or the request never reaching the server at all (network failure) — never a raw
 * exception/stack trace surfaced to the user.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface BackendErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // fetch itself threw — the request never reached the server (offline, DNS failure, the
    // API container not running, CORS preflight rejection, etc.). Distinguished from a
    // server-returned error so the UI can say something more useful than a generic message.
    throw new ApiError('Could not reach the API. Is the backend running?', null);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const errorBody = (body ?? {}) as BackendErrorBody;
    // Nest's default exception filter returns `message` as either a single string
    // (e.g. NotFoundException, ConflictException) or an array of strings (class-validator's
    // flattened field errors, see validate-event-payload.ts) — normalized here so every
    // caller can rely on a single string for the headline message, with the full list
    // available separately for a field-by-field display.
    const details = Array.isArray(errorBody.message) ? errorBody.message : undefined;
    const message =
      (Array.isArray(errorBody.message) ? errorBody.message.join('; ') : errorBody.message) ??
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, details);
  }

  return body as T;
}

export function submitEvent(
  idempotencyKey: string,
  input: SubmitEventInput,
): Promise<PayrollEvent> {
  return request<PayrollEvent>('/events', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function listEvents(params: ListEventsParams = {}): Promise<ListEventsResponse> {
  const search = new URLSearchParams();
  if (params.employeeId) search.set('employeeId', params.employeeId);
  if (params.status) search.set('status', params.status);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const query = search.toString();
  return request<ListEventsResponse>(`/events${query ? `?${query}` : ''}`);
}

export function getEvent(id: string): Promise<PayrollEventDetail> {
  return request<PayrollEventDetail>(`/events/${encodeURIComponent(id)}`);
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export { API_BASE_URL };
