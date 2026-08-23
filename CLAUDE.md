# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Payroll Event Processing Service — see `docs/assignment.md` for the full assignment brief
(authoritative source of requirements) and `/Users/mdtaijulislam/.claude/plans/wild-zooming-lightning.md`
for the approved architecture/implementation plan this repo is being built against.

NestJS + TypeScript backend (API + worker share one codebase, two entrypoints), PostgreSQL
via Prisma, Redis/BullMQ for async processing, a minimal frontend, Docker Compose for local
dev, GitHub Actions for CI.

## Repository layout

```
backend/    NestJS API + worker
  src/
    main.ts       HTTP entrypoint
    worker.ts     BullMQ worker entrypoint (added in implementation Phase 5)
  prisma/         schema + migrations (added in Phase 2)
  test/           e2e/integration tests
frontend/   Minimal demonstration UI (added in Phase 8)
docs/       Assignment brief
```

## Commands (run from `backend/`)

```
npm run start:dev     # API, watch mode
npm run worker:dev     # worker, watch mode (once worker.ts exists)
npm run lint
npm run typecheck
npm test              # unit tests
npm run test:e2e      # e2e/integration tests
npm run build
```

## Conventions established so far

- `event_type` and `status` columns are plain `varchar` + app-level validation, not native
  Postgres `ENUM` types (keeps adding new event types migration-light).
- The worker always re-reads event state from Postgres rather than trusting BullMQ job
  payload data — Postgres is the single source of truth.
- Status transitions on `payroll_events` are guarded by compare-and-swap `UPDATE ... WHERE
  status = '<expected>'` and are mirrored into an append-only `event_status_history` table
  in the same transaction, for audit traceability.
- Per-employee ordering is enforced via a `sequence` column plus a worker-side check that
  defers (does not fail) a job when an earlier-sequence event for the same employee hasn't
  reached a terminal state yet.
- The Docker image for the backend is built once and reused for both the `api` and `worker`
  Compose services via a `command:` override — there are not two separate Dockerfiles.

Consult the plan file above for the full rationale behind each of these before changing them.
