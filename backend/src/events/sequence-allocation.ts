import { Prisma } from '@prisma/client';

/**
 * Per-employee sequence allocation — the one place in this codebase that talks to
 * PostgreSQL via raw SQL instead of Prisma's query builder, isolated here specifically
 * because it does so (architecture.md §7/§12, database-design.md §9).
 *
 * MUST be called from inside an already-open Prisma transaction (`tx`), and the caller
 * MUST NOT commit that transaction until the row using the returned sequence has been
 * inserted — the advisory lock below is transaction-scoped and is only actually doing its
 * job while the transaction is still open.
 *
 * Mechanism (exactly as approved, not `SELECT ... FOR UPDATE`, no `employees` table):
 *   1. `pg_advisory_xact_lock(hashtext(employeeId)::bigint)` — a PostgreSQL
 *      transaction-level advisory lock keyed on a hash of employeeId. It needs no row to
 *      lock against (there is deliberately no `employees` table — architecture.md §7/§25),
 *      is held only for this transaction's duration, and is released automatically on
 *      commit or rollback.
 *   2. `SELECT COALESCE(MAX(sequence), 0) + 1 ...` — because the lock blocks any other
 *      transaction trying to allocate a sequence for the *same* employeeId until this one
 *      commits or rolls back, this read is guaranteed current for that employee by the time
 *      it runs (Postgres re-takes a fresh statement-level snapshot under READ COMMITTED,
 *      Prisma's default transaction isolation level).
 *
 * Two different employeeIds hash to (almost always) different lock keys and never contend
 * — this is what keeps unrelated employees' submissions from blocking each other
 * (assignment §9). `UNIQUE(employee_id, sequence)` remains the unconditional database-level
 * invariant regardless of this function's correctness — see database-design.md §9 for the
 * full race-condition rationale, including the documented, harmless hashtext()
 * collision caveat.
 */
export async function allocateNextSequence(
  tx: Prisma.TransactionClient,
  employeeId: string,
): Promise<bigint> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId})::bigint)`;

  const rows = await tx.$queryRaw<{ next_sequence: bigint }[]>`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
    FROM payroll_events
    WHERE employee_id = ${employeeId}
  `;

  return rows[0].next_sequence;
}
