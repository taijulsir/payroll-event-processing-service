import { Prisma } from '@prisma/client';

/**
 * True if `err` is a Postgres unique-constraint violation (Prisma error code P2002) that
 * involves the given column. Prisma's `meta.target` shape for this code varies by
 * provider/version — for PostgreSQL it is typically the constraint name as a string (e.g.
 * `"payroll_events_idempotency_key_key"`), but defensively also handles the array-of-field
 * -names shape some Prisma versions/providers use.
 */
export function isUniqueConstraintViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  if (typeof target === 'string') {
    return target.includes(column);
  }
  if (Array.isArray(target)) {
    return target.includes(column);
  }
  return false;
}
