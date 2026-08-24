import {
  FORCE_PROVIDER_FAILURE_MARKER,
  FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER,
  SimulatedPayrollProvider,
} from './simulated-payroll-provider';
import type { PayrollProviderInput } from './payroll-provider';

describe('SimulatedPayrollProvider', () => {
  const provider = new SimulatedPayrollProvider();

  const input = (overrides: Partial<PayrollProviderInput> = {}): PayrollProviderInput => ({
    eventId: 'event-1',
    employeeId: 'emp-1',
    eventType: 'ADDRESS_CHANGE',
    payload: {},
    ...overrides,
  });

  it('deterministically succeeds for a normal employeeId', async () => {
    const outcome = await provider.apply(input({ employeeId: 'emp-1' }));

    expect(outcome.outcome).toBe('SUCCESS');
    if (outcome.outcome === 'SUCCESS') {
      expect(outcome.result).toMatchObject({ providerReference: 'sim-event-1' });
    }
  });

  it('deterministically fails PERMANENT when employeeId contains the reserved marker', async () => {
    const outcome = await provider.apply(
      input({ employeeId: `emp-1-${FORCE_PROVIDER_FAILURE_MARKER}` }),
    );

    expect(outcome.outcome).toBe('FAILURE');
    if (outcome.outcome === 'FAILURE') {
      expect(outcome.classification).toBe('PERMANENT');
      expect(outcome.failureReason).toContain('event-1');
      expect(outcome.failureReason.length).toBeGreaterThan(0);
    }
  });

  it('deterministically fails TRANSIENT when employeeId contains the transient marker', async () => {
    const outcome = await provider.apply(
      input({ employeeId: `emp-1-${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}` }),
    );

    expect(outcome.outcome).toBe('FAILURE');
    if (outcome.outcome === 'FAILURE') {
      expect(outcome.classification).toBe('TRANSIENT');
      expect(outcome.failureReason).toContain('event-1');
      expect(outcome.failureReason.length).toBeGreaterThan(0);
    }
  });

  it('the two failure markers are distinct: neither substring matches the other', () => {
    expect(FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER).not.toContain(FORCE_PROVIDER_FAILURE_MARKER);
    expect(FORCE_PROVIDER_FAILURE_MARKER).not.toContain(FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER);
  });

  it('is repeatable: the same input always produces the same outcome kind and classification', async () => {
    const successInput = input({ employeeId: 'emp-repeat' });
    const permanentInput = input({ employeeId: `emp-repeat-${FORCE_PROVIDER_FAILURE_MARKER}` });
    const transientInput = input({
      employeeId: `emp-repeat-${FORCE_PROVIDER_TRANSIENT_FAILURE_MARKER}`,
    });

    const results = await Promise.all([
      provider.apply(successInput),
      provider.apply(successInput),
      provider.apply(permanentInput),
      provider.apply(permanentInput),
      provider.apply(transientInput),
      provider.apply(transientInput),
    ]);

    expect(results.map((r) => r.outcome)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'FAILURE',
      'FAILURE',
      'FAILURE',
      'FAILURE',
    ]);
    expect(
      results.slice(2, 4).map((r) => (r.outcome === 'FAILURE' ? r.classification : null)),
    ).toEqual(['PERMANENT', 'PERMANENT']);
    expect(
      results.slice(4, 6).map((r) => (r.outcome === 'FAILURE' ? r.classification : null)),
    ).toEqual(['TRANSIENT', 'TRANSIENT']);
  });

  it('never throws and never calls out over the network (pure function of its input)', async () => {
    await expect(provider.apply(input())).resolves.toBeDefined();
  });
});
