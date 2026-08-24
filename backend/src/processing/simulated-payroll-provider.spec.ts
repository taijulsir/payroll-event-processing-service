import {
  FORCE_PROVIDER_FAILURE_MARKER,
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

  it('deterministically fails when employeeId contains the reserved marker', async () => {
    const outcome = await provider.apply(
      input({ employeeId: `emp-1-${FORCE_PROVIDER_FAILURE_MARKER}` }),
    );

    expect(outcome.outcome).toBe('FAILURE');
    if (outcome.outcome === 'FAILURE') {
      expect(outcome.failureReason).toContain('event-1');
      expect(outcome.failureReason.length).toBeGreaterThan(0);
    }
  });

  it('is repeatable: the same input always produces the same outcome kind', async () => {
    const successInput = input({ employeeId: 'emp-repeat' });
    const failureInput = input({ employeeId: `emp-repeat-${FORCE_PROVIDER_FAILURE_MARKER}` });

    const results = await Promise.all([
      provider.apply(successInput),
      provider.apply(successInput),
      provider.apply(failureInput),
      provider.apply(failureInput),
    ]);

    expect(results.map((r) => r.outcome)).toEqual(['SUCCESS', 'SUCCESS', 'FAILURE', 'FAILURE']);
  });

  it('never throws and never calls out over the network (pure function of its input)', async () => {
    await expect(provider.apply(input())).resolves.toBeDefined();
  });
});
