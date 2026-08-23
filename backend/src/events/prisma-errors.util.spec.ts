import { Prisma } from '@prisma/client';
import { isUniqueConstraintViolationOn } from './prisma-errors.util';

function p2002(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('isUniqueConstraintViolationOn', () => {
  it('matches a P2002 error whose target is the constraint name (Postgres string form)', () => {
    const err = p2002('payroll_events_idempotency_key_key');
    expect(isUniqueConstraintViolationOn(err, 'idempotency_key')).toBe(true);
  });

  it('matches a P2002 error whose target is an array of field names', () => {
    const err = p2002(['idempotency_key']);
    expect(isUniqueConstraintViolationOn(err, 'idempotency_key')).toBe(true);
  });

  it('does not match a P2002 error on a different constraint', () => {
    const err = p2002('payroll_events_employee_id_sequence_key');
    expect(isUniqueConstraintViolationOn(err, 'idempotency_key')).toBe(false);
  });

  it('does not match a non-P2002 Prisma error', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(isUniqueConstraintViolationOn(err, 'idempotency_key')).toBe(false);
  });

  it('does not match a plain Error', () => {
    expect(isUniqueConstraintViolationOn(new Error('boom'), 'idempotency_key')).toBe(false);
  });
});
