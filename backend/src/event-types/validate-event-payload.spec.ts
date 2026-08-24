import { validateEventPayload } from './validate-event-payload';

/**
 * Unit tier (architecture.md §18: "DTO validation per event type" — "pure logic, no I/O").
 * No Nest bootstrap, no database — the concurrency/idempotency/sequence behavior this
 * function feeds into is covered separately in test/events-submission.e2e-spec.ts against a
 * real PostgreSQL, per architecture.md §18's own tier split.
 */
describe('validateEventPayload', () => {
  it('accepts a valid ADDRESS_CHANGE payload', async () => {
    const result = await validateEventPayload({
      eventType: 'ADDRESS_CHANGE',
      employeeId: 'emp-1',
      effectiveDate: '2026-01-01',
      street: '1 Example Street',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    });
    expect(result.eventType).toBe('ADDRESS_CHANGE');
    expect(result.payload).not.toHaveProperty('eventType');
    expect(result.payload.city).toBe('Berlin');
  });

  it('accepts a valid BANK_ACCOUNT_CHANGE payload', async () => {
    const result = await validateEventPayload({
      eventType: 'BANK_ACCOUNT_CHANGE',
      employeeId: 'emp-1',
      effectiveDate: '2026-01-01',
      iban: 'DE89370400440532013000',
    });
    expect(result.eventType).toBe('BANK_ACCOUNT_CHANGE');
  });

  it('accepts a valid SALARY_CHANGE payload', async () => {
    const result = await validateEventPayload({
      eventType: 'SALARY_CHANGE',
      employeeId: 'emp-1',
      effectiveDate: '2026-01-01',
      newSalary: 52000,
      currency: 'EUR',
    });
    expect(result.eventType).toBe('SALARY_CHANGE');
  });

  it('rejects a missing/unknown eventType', async () => {
    await expect(validateEventPayload({ employeeId: 'emp-1' })).rejects.toThrow();
    await expect(
      validateEventPayload({ eventType: 'NOT_A_REAL_TYPE', employeeId: 'emp-1' }),
    ).rejects.toThrow();
  });

  it('rejects a non-object body', async () => {
    await expect(validateEventPayload('not an object')).rejects.toThrow();
    await expect(validateEventPayload(null)).rejects.toThrow();
    await expect(validateEventPayload(['array'])).rejects.toThrow();
  });

  it('rejects a missing required field for the given event type', async () => {
    await expect(
      validateEventPayload({
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: 'emp-1',
        effectiveDate: '2026-01-01',
        // iban missing
      }),
    ).rejects.toThrow();
  });

  it('rejects an implausible IBAN', async () => {
    await expect(
      validateEventPayload({
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: 'emp-1',
        effectiveDate: '2026-01-01',
        iban: 'not-an-iban',
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive salary', async () => {
    await expect(
      validateEventPayload({
        eventType: 'SALARY_CHANGE',
        employeeId: 'emp-1',
        effectiveDate: '2026-01-01',
        newSalary: -1,
        currency: 'EUR',
      }),
    ).rejects.toThrow();
  });

  it('rejects an unknown extra field (whitelist)', async () => {
    await expect(
      validateEventPayload({
        eventType: 'ADDRESS_CHANGE',
        employeeId: 'emp-1',
        effectiveDate: '2026-01-01',
        street: '1 Example Street',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
        notAField: 'x',
      }),
    ).rejects.toThrow();
  });
});
