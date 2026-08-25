# Payroll Event Processing Service

A backend service that accepts payroll-related events (bank account changes, address
changes, salary changes) over HTTP and processes them asynchronously against a simulated
external payroll provider, using PostgreSQL as the durable source of truth and Redis/BullMQ
for the work queue. Built with NestJS and TypeScript.

## Overview

The system separates two concerns: **accepting** a payroll event (fast, synchronous, durable)
and **processing** it (slow, asynchronous, retried on failure). An HTTP request never waits
for processing to finish.

Main flow:

```
Client → API (validate, persist, enqueue) → PostgreSQL (durable state)
                                           → Redis/BullMQ (work queue)
                                                → Worker (claim, call provider, persist outcome)
                                                     → Simulated Payroll Provider
```

The API is the only writer of new events and the only reader for status/history. The worker
is a separate process that consumes jobs from BullMQ, always re-reads the current state from
PostgreSQL (never trusts the job payload as truth), and performs the actual state transition.
PostgreSQL is authoritative for every fact about an event; Redis holds only pending work, never
business state.

## Architecture

```mermaid
flowchart TD
    Client["Client / Frontend"] -->|"POST /events, GET /events, GET /events/:id"| API["NestJS API"]
    API -->|"insert event, assign sequence, write history"| DB[("PostgreSQL")]
    API -->|"enqueue job (after commit)"| Queue["Redis / BullMQ"]
    Queue -->|"deliver job"| Worker["NestJS Worker"]
    Worker -->|"claim (CAS), write result + history"| DB
    Worker -->|"simulated call"| Provider["Simulated Payroll Provider"]
    Client -->|"GET /health"| API
    API -.->|"liveness check"| DB
    API -.->|"liveness check"| Queue
```

| Component | Role |
|---|---|
| **API** (`backend/src/main.ts`) | Validates requests, persists events, assigns per-employee sequence numbers, enforces idempotency, enqueues work after commit, serves read endpoints. Stateless. |
| **PostgreSQL** | The single source of durable, authoritative state — current status, attempts, result, and full transition history for every event. |
| **Redis / BullMQ** | The work queue only. Holds pending jobs, not business state. If Redis is unavailable when a job would be enqueued, the event stays durably `PENDING` in Postgres and is recovered later (see [Failure and Recovery](#failure-and-recovery)). |
| **Worker** (`backend/src/worker.ts`) | A second entrypoint sharing the same application code as the API. Consumes jobs, claims events with an atomic compare-and-swap, invokes the provider, persists the outcome, and runs the periodic recovery/reconciliation sweeps. Runs as a separate process from the API. |
| **Simulated Payroll Provider** (`backend/src/processing/simulated-payroll-provider.ts`) | An in-process stand-in for a real external payroll system — no real external integration, per the assignment. Deterministic, not random: it succeeds unless `employeeId` contains a reserved marker substring, which forces a transient or permanent failure on demand (see [Testing](#testing)). |
| **Frontend** (`frontend/`) | A minimal Next.js UI that talks to the API directly from the browser to submit and observe events — see [Frontend](#frontend). |

## Core Guarantees

Only what is actually implemented and tested:

- **Idempotent submission**: `POST /events` requires an `Idempotency-Key` header. The key is
  enforced by a database `UNIQUE` constraint; a retried request with the same key returns the
  original event instead of creating a duplicate. Reusing a key with a materially different
  payload is rejected with `409 Conflict`.
- **Per-employee ordering**: events for the same employee are processed in the order they were
  accepted. The claim step atomically checks "does an earlier, non-terminal event for this
  employee exist?" as part of the same guarded database statement that claims the job — never
  as a separate check-then-act step. A blocked job is deferred (BullMQ `moveToDelayed`) without
  consuming its retry budget. Different employees process concurrently.
- **Duplicate/concurrent processing safety**: an event is claimed via an atomic
  `UPDATE ... WHERE status = 'PENDING'`; only one concurrent claim attempt can ever win. A
  redelivered job for an already-terminal (`SUCCEEDED`/`FAILED`) event is a safe no-op.
- **Retryable vs. permanent failures**: the simulated provider classifies each failure as
  `TRANSIENT` or `PERMANENT`. Transient failures return the event to `PENDING` and are retried
  (BullMQ backoff, up to a configured attempt budget); permanent failures go straight to
  `FAILED` and are never retried.
- **Retry-budget exhaustion backstop**: if BullMQ's own delivery attempts are exhausted before
  the primary path finalizes an event, a `failed`-event listener reconciles it to
  `FAILED`/`RETRYABLE` so it never stays stuck in `PROCESSING`.
- **Stale-processing recovery**: a periodic sweep finds events stuck in `PROCESSING` past a
  timeout (worker crashed mid-job) and returns them to `PENDING` for reclaiming, or finalizes
  them as `FAILED` if their attempt budget is already spent.
- **Enqueue-gap reconciliation**: the database commit and the Redis enqueue call are not in the
  same transaction. A periodic sweep finds `PENDING` events older than a threshold with no
  corresponding job and re-enqueues them, closing the gap if the initial enqueue call failed or
  never happened.
- **Explicit state model**: `PENDING → PROCESSING → SUCCEEDED`, `PROCESSING → PENDING` (retry),
  `PROCESSING → FAILED` (permanent, or retries exhausted). Every transition is recorded in an
  append-only history table in the same transaction as the state change.
- **Provider invocation is at-least-once, not exactly-once**: in one narrow crash window (after
  the provider call succeeds, before the finishing transaction commits), a redelivered job can
  call the provider again. This is safe here because the provider is simulated and has no real
  side effect outside Postgres; it would not be safe against a non-idempotent real provider.
  Stated plainly rather than overclaimed.

## Project Structure

```
payroll-event-processing-service/
├── backend/
│   ├── src/
│   │   ├── main.ts            # HTTP API entrypoint
│   │   ├── worker.ts          # BullMQ worker entrypoint
│   │   ├── events/            # POST/GET /events — controller, DTOs, service
│   │   ├── event-types/       # per-event-type validation DTOs + registry
│   │   ├── processing/        # queue, worker processor, provider simulation,
│   │   │                      #   retry/recovery/reconciliation sweeps
│   │   ├── health/            # GET /health
│   │   └── prisma/            # injectable Prisma client
│   ├── prisma/                # schema.prisma + migrations
│   ├── test/                  # e2e/integration tests (real Postgres + Redis)
│   └── Dockerfile
├── frontend/                  # Next.js static export (list / submit / detail)
├── docs/
│   ├── assignment.md          # original assignment brief (authoritative, unmodified)
│   ├── architecture.md        # detailed architecture and design rationale
│   └── database-design.md     # detailed schema, indexes, and constraint rationale
├── docker-compose.yml         # postgres, redis, migrate, api, worker, frontend
└── .github/workflows/ci.yml   # lint/typecheck/build/unit/e2e/docker-build pipeline
```

## Requirements

- Docker and Docker Compose (the supported way to run the full system)
- Node.js 20 and npm — only needed for running services outside Docker (matches
  `node:20-alpine` used by both Dockerfiles and the CI pipeline's `node-version: '20'`)

## Environment Variables

Each `.env.example` file is the source of truth; copy it to `.env` in the same directory to
override a default. None of the values below are real secrets — they are local-only
development defaults. Every deployment-specific value (hostnames, ports, the frontend's
public origin, the API's public base URL) is environment-driven — changing deployment target
(local machine, a VM, anywhere else) never requires editing `docker-compose.yml` or any
application source file, only `.env`.

**Root `.env.example`** — consumed only by `docker-compose.yml`'s own variable substitution,
not read by the application processes directly:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the `api` container's NestJS process listens on internally |
| `API_PORT` | `3000` | Host port mapped to the `api` container's `PORT` |
| `FRONTEND_PORT` | `3001` | Host port mapped to the `frontend` container's port `80` |
| `FRONTEND_ORIGIN` | `http://localhost:3001` | The frontend's browser-reachable origin; passed into the `api` container as `FRONTEND_ORIGIN` (CORS allowlist). For a VM/remote deployment, set this to the public origin the frontend is actually served at |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3000` | The API's browser-reachable base URL; passed to the `frontend` image as a **build ARG** and baked into the static export (see [Frontend Configuration](#frontend-configuration-build-time-vs-runtime) below). For a VM/remote deployment, set this to the API's actual public address |
| `REDIS_PORT` | `6379` | Port the `redis` container listens on internally and that `api`/`worker` connect to. Not published to the host by default |
| `POSTGRES_USER` | `payroll` | PostgreSQL user, passed to the `postgres` container and assembled into `DATABASE_URL` for `migrate`/`api`/`worker` |
| `POSTGRES_PASSWORD` | `payroll` | PostgreSQL password. **Change this for any deployment reachable by anyone but you** (e.g. a VM) — the default is a known, publicly-visible value in this example file. Postgres itself is never published to the host either way (defense-in-depth, not the only control) |
| `POSTGRES_DB` | `payroll` | PostgreSQL database name |

`POSTGRES_PORT` is not a root variable — PostgreSQL's internal port never changes (see
[Ports and Exposure](#ports-and-exposure)); it only appears in
`docker-compose.override.yml.example` for optional local host access.
`POSTGRES_USER`/`PASSWORD`/`DB` only take effect when PostgreSQL initializes an **empty**
`postgres_data` volume. On an existing deployment, editing `.env` afterward does **not**
change the running database's actual role password — that role must be changed directly in
PostgreSQL (e.g. `ALTER USER ... WITH PASSWORD ...`), with `.env`/`DATABASE_URL` then updated
to match. `docker compose down -v` deletes the volume and all data with it; it is not a
credential-rotation procedure.

**`backend/.env.example`** — read by the API and worker processes when run directly (outside
Docker Compose; under Compose, `docker-compose.yml`'s own `environment:` block supplies these
instead, itself driven by the root `.env` above):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port the API listens on — deployment-specific, never hardcoded (`main.ts` reads `process.env.PORT`) |
| `NODE_ENV` | `development` | Standard Node environment flag |
| `FRONTEND_ORIGIN` | `http://localhost:3001` | The single allowed CORS origin — must be the browser-reachable frontend URL, never a Docker-internal hostname |
| `DATABASE_URL` | `postgresql://payroll:payroll@localhost:5432/payroll?schema=public` | Prisma/PostgreSQL connection string |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis connection used for BullMQ |

The simulated payroll provider (`backend/src/processing/simulated-payroll-provider.ts`) has no
environment configuration — it is deterministic, not randomized (see
[Known Limitations](#known-limitations)).

**`frontend/.env.example`** — read at build time only, when building the frontend directly
(outside Docker; this is a static export, there is no frontend server at runtime to read an
environment variable from later). Under Docker Compose, the root `.env`'s
`NEXT_PUBLIC_API_BASE_URL` (passed as a build ARG) is used instead — see
[Frontend Configuration](#frontend-configuration-build-time-vs-runtime).

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3000` | The backend API's browser-reachable base URL, baked into the static build |

## Running with Docker Compose

```bash
docker compose up --build
```

This starts, in dependency order:

1. **postgres** (`postgres:16-alpine`) and **redis** (`redis:7-alpine`) — with health checks.
2. **migrate** — a one-off job that runs `prisma migrate deploy` against Postgres and exits;
   `api` and `worker` wait for it to complete successfully before starting, so neither ever
   queries an unmigrated schema.
3. **api** — the HTTP API, published at `http://localhost:3000` by default.
4. **worker** — the BullMQ consumer. No published port; it does not serve HTTP.
5. **frontend** — a static Next.js export served by nginx, published at
   `http://localhost:3001` by default.

`api`, `worker`, and `migrate` all build from the same `backend/Dockerfile` (a single
multi-stage image, selected via a different `command:` per service) — there is no second
backend Dockerfile. `frontend` builds from its own `frontend/Dockerfile`.

Once running, with default `.env` values:

- API: `http://localhost:3000`
- Health check: `http://localhost:3000/health`
- Swagger UI: `http://localhost:3000/api`
- Frontend: `http://localhost:3001`

### Ports and Exposure

Only two ports are ever published to the host, both bound to `127.0.0.1` only and both
configurable (`API_PORT`/`FRONTEND_PORT` in the root `.env`), with no source or Compose-file
change required to move them:

| Service | Host exposure | Notes |
|---|---|---|
| `frontend` | `127.0.0.1:${FRONTEND_PORT:-3001}` → container port `80` | Static export served by nginx |
| `api` | `127.0.0.1:${API_PORT:-3000}` → container port `${PORT:-3000}` | HTTP API + Swagger UI |
| `worker` | None | No HTTP server; BullMQ consumer only |
| `postgres` | **None** | No `ports:` mapping at all — reachable only from other containers, as `postgres`, on Compose's internal network, always on port `5432` |
| `redis` | **None** | Reachable only as `redis`, on the port `REDIS_PORT` configures (`6379` by default) |

Public access, if any, is a separate concern from this Compose file: a host-level reverse
proxy (e.g. Nginx terminating TLS on `80`/`443`) forwards to these `127.0.0.1` ports. That
proxy is not part of this repository — see [VM / Remote Deployment](#vm--remote-deployment).

PostgreSQL and Redis are never published to the host on any deployment target, local or
remote — this is not a production-only hardening step, it is how `docker-compose.yml` is
written. `docker-compose.override.yml.example` (git-ignored once copied, never present on a
fresh clone or a VM) is the only way to publish them, on `127.0.0.1` only, for local tools
that need direct access (`npm run test:e2e`, `psql`, `redis-cli`).

## Frontend Configuration (Build-Time vs Runtime)

The frontend is a Next.js **static export** (`output: 'export'` in `next.config.ts`) — `next
build` produces plain HTML/JS/CSS served by nginx, with no Node.js process and no server at
runtime. This has one direct consequence for configuration: **there is nothing running at
request time that could read a runtime environment variable.** Any value the frontend needs —
here, just the API's base URL — has to be resolved at build time and inlined into the
JavaScript bundle, using Next.js's own `NEXT_PUBLIC_*` convention
(`frontend/lib/api.ts` reads `process.env.NEXT_PUBLIC_API_BASE_URL`, falling back to
`http://localhost:3000` only if it was never supplied at build time).

In `docker-compose.yml`, this is wired as a build **ARG**, not a container `environment:`
entry — an `environment:` value would have no effect, since nothing reads it after the static
files are already baked:

```yaml
frontend:
  build:
    args:
      NEXT_PUBLIC_API_BASE_URL: ${NEXT_PUBLIC_API_BASE_URL:-http://localhost:${API_PORT:-3000}}
```

Practical implications:
- Changing `NEXT_PUBLIC_API_BASE_URL` requires `docker compose build frontend` (or `up
  --build`) — restarting the container alone has no effect, because the value is already
  compiled into the JavaScript.
- The value must be an address the **browser** can reach — never a Compose-internal service
  name like `http://api:3000`, which only resolves between containers, not from the user's
  machine.
- No fake "runtime config" shim (e.g. an injected `window.__ENV__` fetched from a JSON file at
  page load) was introduced to work around this — that would be extra moving parts solving a
  problem this architecture doesn't actually have: a full rebuild on config change is a
  correct and sufficient answer for a static export this size, not a limitation to engineer
  around.

## Database Migrations

Migrations are Prisma migrations under `backend/prisma/migrations/`. In Docker Compose, the
`migrate` service applies them automatically on every `docker compose up` by running
`prisma migrate deploy` (idempotent — a no-op if the schema is already current) before `api`
or `worker` start. There is no separate manual migration step required for the Docker
workflow.

Outside Docker, from `backend/`:

```bash
npm run prisma:migrate:deploy   # apply existing migrations (non-interactive)
npm run prisma:migrate:dev      # create/apply a migration during local development
npm run prisma:validate         # validate schema.prisma without connecting to a database
```

## VM / Remote Deployment

The same `docker-compose.yml` used for local development runs unchanged on a VM — nothing in
this repository needs to be edited to change deployment target, only `.env`. On the VM:

```bash
cp .env.example .env
```

Then set the values that must reflect where the VM is actually reachable from (its public IP
or DNS name) and a real database password, for example a VM with a public IP address or DNS
name:

```bash
# .env
PORT=3000
API_PORT=3000
FRONTEND_PORT=3001
FRONTEND_ORIGIN=https://payroll.taijul.dev
NEXT_PUBLIC_API_BASE_URL=https://payroll.taijul.dev/api
POSTGRES_PASSWORD=<a real generated password, not the example default>
```

```bash
docker compose up --build
```

- `api`/`frontend` publish to `127.0.0.1` only (see
  [Ports and Exposure](#ports-and-exposure)) — public HTTPS access requires a host-level
  reverse proxy (e.g. Nginx on `80`/`443`) forwarding to `127.0.0.1:${API_PORT}` and
  `127.0.0.1:${FRONTEND_PORT}`. That proxy and any TLS cert are configured outside this
  repository and outside `docker-compose.yml`.
- `FRONTEND_ORIGIN` becomes the API's CORS allowlist entry — it must exactly match the public
  origin the frontend is actually served from (the reverse proxy's domain, not a bare
  `IP:port`), or the browser will reject cross-origin requests.
- `NEXT_PUBLIC_API_BASE_URL` is baked into the frontend's static build (see
  [Frontend Configuration](#frontend-configuration-build-time-vs-runtime)) — it must be an
  address the browser can reach, i.e. the public domain/path the reverse proxy routes to the
  API, never a Compose-internal hostname or a `127.0.0.1` address.
- `PORT` (the api container's internal listen port) and `API_PORT` (its host-loopback
  mapping) only need to change if `3000` is already in use on the VM — keep them equal. Same
  for `FRONTEND_PORT`/`3001`.
- `POSTGRES_PASSWORD` (and `POSTGRES_USER`/`POSTGRES_DB`, if desired) should be changed from
  the `.env.example` default on any VM — it's a value visible in this public repository.
  PostgreSQL is never published to the host either way (see
  [Ports and Exposure](#ports-and-exposure)), so this is defense-in-depth, not the only
  control. Set it in `.env` **before** the first `docker compose up`, so PostgreSQL
  initializes its empty volume with that password directly.
  To rotate the credential on an **existing** deployment, change the role's password inside
  PostgreSQL itself first, then update `.env`/`DATABASE_URL` to match — editing `.env` alone
  has no effect on an already-initialized database. `docker compose down -v` deletes the
  data volume; it is a destructive last resort, never a normal way to change a password.
- `REDIS_PORT` only needs to change to avoid a conflict on the VM; it is never published to
  the host and has no credentials in this setup.
- This is a plain Docker Compose deployment to a single host — no reverse proxy, TLS
  termination, or orchestration layer is part of this repository (see
  [Explicitly Out of Scope](docs/architecture.md#25-explicitly-out-of-scope)); a host-level
  reverse proxy is what makes the API/frontend publicly reachable at all, since Compose only
  binds them to `127.0.0.1`.

## Live Deployment

This project is deployed and verified live on a self-hosted VM, using exactly the Docker
Compose setup and architecture described in
[VM / Remote Deployment](#vm--remote-deployment) above.

- Application: <https://payroll.taijul.dev/>
- API: <https://payroll.taijul.dev/api/>
- API health: <https://payroll.taijul.dev/api/health>
- Swagger UI: <https://payroll.taijul.dev/swagger/>

Nginx runs directly on the VM host (outside Docker) as the public reverse proxy and TLS
termination layer (Let's Encrypt/Certbot), listening on `80`/`443` and forwarding to the
`api`/`frontend` containers, which publish their host ports on `127.0.0.1` only (see
[Ports and Exposure](#ports-and-exposure)). PostgreSQL and Redis have no host port mapping
and remain reachable only inside the Docker Compose network — the live API health endpoint
above confirms both are up.

## Running Locally Without Docker

Requires a reachable PostgreSQL and Redis (for example, `docker compose up postgres redis`)
and `backend/.env` configured to point at them. From `backend/`:

```bash
npm install
npm run prisma:migrate:deploy
npm run start:dev     # API, watch mode
npm run worker:dev    # worker, watch mode — run in a second terminal
```

From `frontend/`, with `frontend/.env` pointing `NEXT_PUBLIC_API_BASE_URL` at the running API:

```bash
npm install
npm run dev
```

## API

Base path: none (routes are mounted at the API root). All responses are JSON.

| Method | Path | Purpose | Key request fields | Required headers | Status codes |
|---|---|---|---|---|---|
| `GET` | `/health` | Liveness of the API and its dependencies | — | — | `200` (all dependencies up), `503` (at least one down) |
| `POST` | `/events` | Submit a payroll event for asynchronous processing | `eventType`, `employeeId`, `effectiveDate`, plus fields specific to `eventType` (see below) | `Idempotency-Key` (required) | `202` accepted, `400` invalid input, `409` idempotency key reused with a different payload |
| `GET` | `/events` | List submitted events | Query: `employeeId?`, `status?`, `limit?` (default 20, max 100), `offset?` | — | `200` |
| `GET` | `/events/:id` | Retrieve one event, including its full status history | — | — | `200`, `404` if no event exists with that id |

`GET /api` and `GET /api-json` serve the interactive Swagger UI and the raw OpenAPI document.

**Supported `eventType` values and their type-specific fields**:

| `eventType` | Additional required fields |
|---|---|
| `BANK_ACCOUNT_CHANGE` | `iban` |
| `ADDRESS_CHANGE` | `street`, `city`, `postalCode`, `country` |
| `SALARY_CHANGE` | `newSalary`, `currency` |

Request bodies are flat JSON objects — `eventType` is a sibling field, not nested under a
`payload` key. Unknown fields are rejected (`400`), not silently ignored.

Example:

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "eventType": "ADDRESS_CHANGE",
    "employeeId": "emp-1001",
    "effectiveDate": "2026-09-01",
    "street": "1 Example Street",
    "city": "Berlin",
    "postalCode": "10115",
    "country": "DE"
  }'
```

The response is the persisted event (`id`, `employeeId`, `eventType`, `sequence`, `status`,
`attempts`, `maxAttempts`, `result`, `failureReason`, `failureType`, and timestamps).
`GET /events/:id` returns the same shape plus `statusHistory`, an ordered array of every
transition the event has gone through. `sequence` is serialized as a decimal string (it is a
64-bit value on the server) to avoid precision loss in JSON.

## Event Processing Lifecycle

1. **Submission**: the API validates the request, and in one transaction assigns the event's
   per-employee sequence number, inserts it as `PENDING`, and records the first history entry.
2. **Enqueue**: after the transaction commits, a BullMQ job (`{ eventId }` only — the worker
   never trusts job payload data) is enqueued with `jobId = eventId`, making a redundant enqueue
   harmless.
3. **Claim**: the worker atomically claims the job — `PENDING → PROCESSING` — only if no
   earlier, non-terminal event exists for the same employee.
4. **Provider call**: outside any database transaction, the worker calls the simulated
   provider.
5. **Outcome**:
   - success → `PROCESSING → SUCCEEDED`, result persisted;
   - permanent failure → `PROCESSING → FAILED` (`failureType: PERMANENT`), not retried;
   - transient failure with budget remaining → `PROCESSING → PENDING`, retried by BullMQ with
     backoff;
   - transient failure with budget exhausted → `PROCESSING → FAILED` (`failureType: RETRYABLE`).
6. Every transition above is written to the append-only history table in the same transaction
   as the status change.

## Failure and Recovery

| Scenario | What happens |
|---|---|
| Redis unavailable when enqueuing | The event is already durably `PENDING` in Postgres; the enqueue failure is logged, not returned to the client as an error. The reconciliation sweep re-enqueues it once Redis is reachable again. |
| Worker crashes mid-processing | The event is left `PROCESSING`. The stale-processing sweep detects it once its `processing_started_at` exceeds the configured timeout and returns it to `PENDING` (or finalizes it as `FAILED` if its attempt budget is already spent). |
| Transient provider failure | Event returns to `PENDING`; BullMQ redelivers it after an exponential backoff delay, up to a configured attempt budget. |
| Permanent provider failure | Event goes straight to `FAILED` and is never retried. |
| BullMQ exhausts its own delivery attempts before the primary path finalizes the event | A `failed`-event listener reconciles the event to `FAILED`/`RETRYABLE` as a backstop. |
| Duplicate/retried HTTP submission | The `Idempotency-Key` uniqueness constraint ensures only the first insert succeeds; a retry with the same key and the same payload returns the original event. |
| Two workers race to claim the same event | Only one atomic `UPDATE ... WHERE status = 'PENDING'` can succeed; the other observes zero rows affected and moves on. |

## Testing

All commands run from `backend/` unless noted.

```bash
npm test          # unit tests (Jest) — no external services required
npm run test:e2e  # integration/e2e tests — require real PostgreSQL and Redis
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run build      # nest build
```

Unit tests live under `backend/src/**/*.spec.ts` (10 suites); integration/e2e tests live under
`backend/test/*.e2e-spec.ts` (13 suites) and exercise real Postgres and Redis, including
concurrent-claim races, retry/backoff timing, ordering, stale-processing recovery, and
reconciliation — not mocked infrastructure.

**Running `test:e2e` locally, with `docker compose up` also running**: each e2e spec boots its
own in-process NestJS application (via `Test.createTestingModule`), including its own BullMQ
worker(s), and connects to whatever Postgres/Redis `backend/.env` points at — the same instances
`docker compose`'s own `api`/`worker` containers use by default (same exposed ports). If the
Docker `worker` container is left running while you run `npm run test:e2e` from the host, it
will race the tests' own workers to claim jobs from the same `payroll-events` queue — since only
one worker can ever win a given job, this produces spurious e2e failures (a test's own worker
losing a job it expected to process, or extra history rows appended by the Docker worker mid-test)
that are an artifact of the duplicate consumer, not a bug in the code under test.

Correct local procedure: stop (not necessarily remove) the containers that consume the queue
before running e2e tests, and restart them afterward if you want the full stack running again:

```bash
docker compose stop api worker    # postgres/redis stay up — e2e needs them
cd backend && npm run test:e2e
docker compose start api worker   # optional, if you want the full stack running again
```

This is a local-workflow caveat only, not a production or architecture concern:
**CI never hits this** — `.github/workflows/ci.yml`'s `e2e` job uses isolated, ephemeral GitHub
Actions Postgres/Redis service containers with no `api`/`worker` container attached to them at
all, so there is never a second consumer to race.

From `frontend/`, `npm run typecheck` and `npm run build` validate the frontend (there is no
frontend test framework — the assignment's testing requirements are backend-scenario-focused).

**CI**: `.github/workflows/ci.yml` runs on pull requests and pushes to `main`/`development`, as
four gated jobs — `verify` (lint, typecheck, build, Prisma schema validation, unit tests) and
`frontend-verify` (frontend typecheck + build) run first; `e2e` (real Postgres/Redis service
containers) and `docker-build` (`docker build` for both the backend and frontend images) are
gated on those passing.

## Frontend

A minimal Next.js (static export, served by nginx in Docker) UI with three screens, consuming
the real backend API from the browser — not a mocked demo:

- **Events list** (`/`) — table of submitted events with employee/status/type filters and
  pagination; auto-refreshes periodically.
- **Submit Event** (`/submit`) — a form whose fields switch based on the selected `eventType`,
  with client-side validation mirroring the backend's rules (the backend remains authoritative).
- **Event detail** (`/event`) — full event information, result or failure detail, and the
  status-history timeline. Polls the event every few seconds until it reaches a terminal state
  (`SUCCEEDED`/`FAILED`), so processing-state changes are visibly observable, with a bounded
  number of attempts rather than polling indefinitely.

The frontend also shows the live `/health` status in its navigation bar.

## Design Decisions / Trade-offs

- **`event_type` and `status` are plain `varchar`, not native PostgreSQL enums** — adding a new
  event type or revising the state machine never requires a schema migration to widen an enum;
  the value set is enforced at the application layer instead.
- **No `Employee` table** — the assignment never asks for employee management, and one isn't
  needed for correctness: per-employee sequence allocation uses a PostgreSQL advisory lock
  keyed on `employeeId` rather than a row lock against a table that would exist for no other
  reason.
- **Idempotency via a database `UNIQUE` constraint plus catching the insert violation**, not a
  pre-check — the constraint is the only mechanism that is race-free under concurrent identical
  retries.
- **Ordering and claiming are combined into one atomic guarded `UPDATE`**, never a
  check-then-act pair — this is what makes the ordering guarantee correct under concurrent
  claim attempts for the same employee.
- **A single BullMQ queue**, not one per employee or event type — per-employee ordering is
  enforced inside the worker's claim logic, not by queue topology, so cross-employee
  concurrency is unaffected.
- **Reconciliation sweeps instead of a transactional outbox/CDC pipeline** — the DB-commit /
  Redis-enqueue gap is closed with a lightweight periodic sweep rather than a full
  outbox+log-shipping system, which would be disproportionate machinery for this assignment's
  scope.
- **`FAILED` is one terminal state**, not split into separate states per failure kind —
  `failureType` (`RETRYABLE`/`PERMANENT`) and `failureReason` carry the distinction instead,
  keeping the state machine smaller.
- **One backend Docker image, reused for `api`/`worker`/`migrate`** via a `command:` override
  per Compose service, instead of maintaining separate Dockerfiles for code that is identical
  except for its entrypoint.
- **PostgreSQL and Redis are never published to the host** — no `ports:` mapping in
  `docker-compose.yml` on any deployment target. `api`/`worker` reach them only through
  Docker's internal service-name DNS, which is identical whether running locally or on a VM.
- **Deployment-specific values (host ports, the frontend's public origin, the API's public
  base URL) are entirely environment-driven** — moving from local development to a VM changes
  only `.env`, never `docker-compose.yml` or application source. The frontend's API base URL
  is the one exception that must be a Docker build ARG rather than a plain env var, because
  it is a static export with no server at runtime to read one from later (see
  [Frontend Configuration](#frontend-configuration-build-time-vs-runtime)).

## API / Operational Notes

Addresses below are local development defaults; on any other deployment target (see
[VM / Remote Deployment](#vm--remote-deployment)) they follow `API_PORT`/`FRONTEND_PORT`/the
VM's actual public address instead — never hardcoded in source.

- API: `http://localhost:3000`
- Frontend: `http://localhost:3001`
- Health check: `GET http://localhost:3000/health`
- Swagger UI: `http://localhost:3000/api` (OpenAPI JSON at `/api-json`)
- `POST /events` requires an `Idempotency-Key` header — a client-supplied identifier for one
  logical submission attempt (a UUID is a reasonable choice); omitting it returns `400`.

## Assignment Coverage

- [x] Event submission (`POST /events`, non-blocking)
- [x] Event status retrieval (`GET /events/:id`)
- [x] Asynchronous processing via Redis and BullMQ, with a simulated provider
- [x] Temporary vs. permanent failure handling
- [x] Duplicate request handling (idempotency)
- [x] Multiple workers and concurrency safety
- [x] Worker failure and recovery
- [x] Processing consistency (crash-after-write scenario)
- [x] Per-employee event ordering, with concurrent processing across employees
- [x] Extensibility (new event types require one DTO + one registry entry, not a rewrite)
- [x] Per-event-type validation
- [x] Event history and audit information
- [x] Automated tests (unit + integration/e2e against real infrastructure)
- [x] `docker compose up` starts API, worker, PostgreSQL, Redis, and the frontend
- [x] GitHub Actions CI pipeline
- [x] Error handling and logging at the required lifecycle points
- [x] Health check endpoint
- [x] API documentation (Swagger/OpenAPI)
- [x] Minimal frontend demonstration, consuming the real backend
- [x] README with setup instructions, architecture, and design trade-offs

## Known Limitations

- No authentication or authorization — explicitly out of scope for this assignment.
- The simulated provider is fully deterministic — it has no random failure rate and no
  simulated latency. It succeeds unless `employeeId` contains a reserved marker substring
  (`FORCE_PROVIDER_FAILURE` / `FORCE_PROVIDER_TRANSIENT_FAILURE`), which forces a permanent or
  transient failure respectively. This is a deliberate choice, not a shortcut: automated tests
  need to force a specific outcome without depending on random chance.
- Provider invocation is at-least-once, not exactly-once, in the narrow crash window described
  under [Core Guarantees](#core-guarantees) — acceptable only because the provider is simulated
  and has no real external side effect.
- Redis and PostgreSQL run without authentication/ACLs beyond a shared local development
  password — appropriate for local Docker Compose use, not a production configuration.
- No horizontal-scaling load testing was performed; concurrency correctness is demonstrated
  through targeted automated tests (concurrent claims, ordering races, idempotent duplicate
  submissions) rather than large-scale load simulation.
