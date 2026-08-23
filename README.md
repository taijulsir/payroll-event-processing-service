# Payroll Event Processing Service

Backend Engineering Technical Assignment — a NestJS + PostgreSQL + Redis/BullMQ service
that accepts payroll events (bank account change, address change, salary change) over HTTP
and processes them asynchronously against a simulated external payroll provider.

> **Status**: under active development. This README is a placeholder scaffolded in Phase 1
> of the implementation plan (see `docs/assignment.md`) and will be filled in fully in the
> final documentation phase.

## Planned sections

- Installation
- Environment variables
- Docker setup (`docker compose up`)
- Database setup and migrations
- Running the API
- Running the worker
- Running tests
- Architecture overview (with diagram)
- Database design
- Background processing design
- Key engineering decisions and trade-offs

## Repository layout

```
backend/    NestJS API + worker (shared codebase, two entrypoints)
frontend/   Minimal demonstration UI
docs/       Assignment brief
```
