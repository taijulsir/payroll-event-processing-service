'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, submitEvent } from '../../lib/api';
import { EVENT_TYPES, type EventType, type SubmitEventInput } from '../../lib/types';
import { formatEventType } from '../../lib/format';

const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface FormState {
  employeeId: string;
  effectiveDate: string;
  iban: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
  newSalary: string;
  currency: string;
  idempotencyKey: string;
}

const generateKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const INITIAL_FORM: FormState = {
  employeeId: 'emp-1001',
  effectiveDate: '2026-08-24',
  iban: 'DE89370400440532013000',
  street: '123 Main Street',
  city: 'Berlin',
  postalCode: '10115',
  country: 'DE',
  newSalary: '75000',
  currency: 'EUR',
  idempotencyKey: 'idem-initial-key',
};

function buildPayload(eventType: EventType, form: FormState): SubmitEventInput {
  switch (eventType) {
    case 'BANK_ACCOUNT_CHANGE':
      return {
        eventType,
        employeeId: form.employeeId.trim(),
        effectiveDate: form.effectiveDate,
        iban: form.iban.trim().toUpperCase(),
      };
    case 'ADDRESS_CHANGE':
      return {
        eventType,
        employeeId: form.employeeId.trim(),
        effectiveDate: form.effectiveDate,
        street: form.street.trim(),
        city: form.city.trim(),
        postalCode: form.postalCode.trim(),
        country: form.country.trim(),
      };
    case 'SALARY_CHANGE':
      return {
        eventType,
        employeeId: form.employeeId.trim(),
        effectiveDate: form.effectiveDate,
        newSalary: Number(form.newSalary),
        currency: form.currency.trim().toUpperCase(),
      };
  }
}

function validate(eventType: EventType, form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!form.employeeId.trim()) errors.employeeId = 'Employee ID is required.';
  if (!form.effectiveDate) errors.effectiveDate = 'Effective date is required.';
  if (!form.idempotencyKey.trim()) errors.idempotencyKey = 'Idempotency Key is required.';

  if (eventType === 'BANK_ACCOUNT_CHANGE') {
    if (!form.iban.trim()) errors.iban = 'IBAN is required.';
    else if (!IBAN_PATTERN.test(form.iban.trim().toUpperCase())) {
      errors.iban = 'IBAN must be a valid format (e.g. DE89370400440532013000).';
    }
  }

  if (eventType === 'ADDRESS_CHANGE') {
    if (!form.street.trim()) errors.street = 'Street address is required.';
    if (!form.city.trim()) errors.city = 'City is required.';
    if (!form.postalCode.trim()) errors.postalCode = 'Postal code is required.';
    if (!form.country.trim()) errors.country = 'Country code is required.';
  }

  if (eventType === 'SALARY_CHANGE') {
    const salary = Number(form.newSalary);
    if (!form.newSalary.trim() || Number.isNaN(salary)) {
      errors.newSalary = 'New salary must be a valid numerical value.';
    } else if (salary <= 0) {
      errors.newSalary = 'New salary must be greater than zero.';
    }
    if (!form.currency.trim()) errors.currency = 'Currency is required.';
    else if (!CURRENCY_PATTERN.test(form.currency.trim().toUpperCase())) {
      errors.currency = 'Currency must be a 3-letter ISO code (e.g. EUR, USD).';
    }
  }

  return errors;
}

export default function SubmitEventPage() {
  const router = useRouter();
  const [eventType, setEventType] = useState<EventType>('BANK_ACCOUNT_CHANGE');
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      idempotencyKey: generateKey(),
      effectiveDate: new Date().toISOString().split('T')[0],
    }));
  }, []);

  const setField = (field: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleRegenerateKey = () => {
    setForm((prev) => ({ ...prev, idempotencyKey: generateKey() }));
  };

  // Test preset helpers
  const applyPreset = (preset: 'happy' | 'transient' | 'permanent' | 'ordering') => {
    const key = generateKey();
    if (preset === 'happy') {
      setForm((prev) => ({
        ...prev,
        employeeId: 'emp-1001',
        idempotencyKey: key,
      }));
    } else if (preset === 'transient') {
      setForm((prev) => ({
        ...prev,
        employeeId: 'emp-1001-FORCE_PROVIDER_TRANSIENT_FAILURE',
        idempotencyKey: key,
      }));
    } else if (preset === 'permanent') {
      setForm((prev) => ({
        ...prev,
        employeeId: 'emp-1001-FORCE_PROVIDER_FAILURE',
        idempotencyKey: key,
      }));
    } else if (preset === 'ordering') {
      setForm((prev) => ({
        ...prev,
        employeeId: 'emp-2002',
        idempotencyKey: key,
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const errors = validate(eventType, form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const payload = buildPayload(eventType, form);
      const created = await submitEvent(form.idempotencyKey.trim(), payload);
      router.push(`/event/?id=${encodeURIComponent(created.id)}&justSubmitted=1`);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.details?.length ? err.details.join(' ') : err.message);
      } else {
        setSubmitError('An unexpected error occurred while submitting the event.');
      }
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <h1>Submit Payroll Event</h1>
          <p className="page-header__desc">
            Dispatches an asynchronous mutation job into BullMQ and persists the event state in PostgreSQL.
          </p>
        </div>
        <div className="page-header__actions">
          <Link href="/events/" className="btn btn-secondary">
            ← Back to Events
          </Link>
        </div>
      </div>

      <div className="card card-padded" style={{ maxWidth: 840, margin: '0 auto' }}>
        <form onSubmit={handleSubmit} noValidate className="form-layout">
          {/* Section 1: Event Type */}
          <div className="form-section">
            <span className="form-section__title">1. Select Event Type</span>
            <div className="type-selector-grid" role="radiogroup" aria-label="Event Type">
              {EVENT_TYPES.map((type) => {
                const isSelected = eventType === type;
                return (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`type-selector-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => {
                      setEventType(type);
                      setFieldErrors({});
                    }}
                  >
                    <span className="type-selector-card__title">{formatEventType(type)}</span>
                    <span className="type-selector-card__desc">
                      {type === 'BANK_ACCOUNT_CHANGE' && 'Update direct deposit IBAN'}
                      {type === 'ADDRESS_CHANGE' && 'Update legal tax/residential address'}
                      {type === 'SALARY_CHANGE' && 'Adjust base compensation & currency'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Preset Helper Bar */}
          <div className="preset-strip">
            <span className="preset-strip__label">Testing Presets:</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => applyPreset('happy')}
            >
              Happy Path (emp-1001)
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => applyPreset('transient')}
              title="Injects FORCE_PROVIDER_TRANSIENT_FAILURE marker to trigger BullMQ retries"
            >
              Transient Failure (Retry Test)
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => applyPreset('permanent')}
              title="Injects FORCE_PROVIDER_FAILURE marker to trigger immediate permanent failure"
            >
              Permanent Failure Test
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => applyPreset('ordering')}
              title="Submits sequentially for emp-2002 to test per-employee ordering"
            >
              Sequence Ordering (emp-2002)
            </button>
          </div>

          {/* Section 2: Routing / Envelope Metadata */}
          <div className="form-section">
            <span className="form-section__title">2. Routing & Scope Metadata</span>
            <div className="form-grid-2">
              <div className="field">
                <label htmlFor="employeeId">
                  Employee Identifier <span className="required-mark">*</span>
                </label>
                <input
                  id="employeeId"
                  type="text"
                  className="mono"
                  placeholder="e.g. emp-1001"
                  value={form.employeeId}
                  onChange={setField('employeeId')}
                  aria-invalid={Boolean(fieldErrors.employeeId)}
                />
                {fieldErrors.employeeId && <span className="error-msg">{fieldErrors.employeeId}</span>}
                <span className="hint-text">Used for per-employee transaction locking & sequence ordering.</span>
              </div>

              <div className="field">
                <label htmlFor="effectiveDate">
                  Effective Date <span className="required-mark">*</span>
                </label>
                <input
                  id="effectiveDate"
                  type="date"
                  value={form.effectiveDate}
                  onChange={setField('effectiveDate')}
                  aria-invalid={Boolean(fieldErrors.effectiveDate)}
                />
                {fieldErrors.effectiveDate && (
                  <span className="error-msg">{fieldErrors.effectiveDate}</span>
                )}
                <span className="hint-text">Date when the payroll modification takes effect.</span>
              </div>
            </div>
          </div>

          {/* Section 3: Event Payload Details */}
          <div className="form-section">
            <span className="form-section__title">3. {formatEventType(eventType)} Payload</span>

            {eventType === 'BANK_ACCOUNT_CHANGE' && (
              <div className="field">
                <label htmlFor="iban">
                  International Bank Account Number (IBAN) <span className="required-mark">*</span>
                </label>
                <input
                  id="iban"
                  type="text"
                  className="mono"
                  placeholder="DE89370400440532013000"
                  value={form.iban}
                  onChange={setField('iban')}
                  aria-invalid={Boolean(fieldErrors.iban)}
                />
                {fieldErrors.iban && <span className="error-msg">{fieldErrors.iban}</span>}
                <span className="hint-text">Must be a valid IBAN pattern.</span>
              </div>
            )}

            {eventType === 'ADDRESS_CHANGE' && (
              <>
                <div className="field">
                  <label htmlFor="street">
                    Street Address <span className="required-mark">*</span>
                  </label>
                  <input
                    id="street"
                    type="text"
                    placeholder="123 Main Street, Apt 4B"
                    value={form.street}
                    onChange={setField('street')}
                    aria-invalid={Boolean(fieldErrors.street)}
                  />
                  {fieldErrors.street && <span className="error-msg">{fieldErrors.street}</span>}
                </div>

                <div className="form-grid-2">
                  <div className="field">
                    <label htmlFor="city">
                      City <span className="required-mark">*</span>
                    </label>
                    <input
                      id="city"
                      type="text"
                      placeholder="Berlin"
                      value={form.city}
                      onChange={setField('city')}
                      aria-invalid={Boolean(fieldErrors.city)}
                    />
                    {fieldErrors.city && <span className="error-msg">{fieldErrors.city}</span>}
                  </div>

                  <div className="field">
                    <label htmlFor="postalCode">
                      Postal Code <span className="required-mark">*</span>
                    </label>
                    <input
                      id="postalCode"
                      type="text"
                      className="mono"
                      placeholder="10115"
                      value={form.postalCode}
                      onChange={setField('postalCode')}
                      aria-invalid={Boolean(fieldErrors.postalCode)}
                    />
                    {fieldErrors.postalCode && (
                      <span className="error-msg">{fieldErrors.postalCode}</span>
                    )}
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="country">
                    Country Code <span className="required-mark">*</span>
                  </label>
                  <input
                    id="country"
                    type="text"
                    placeholder="DE"
                    maxLength={2}
                    value={form.country}
                    onChange={setField('country')}
                    aria-invalid={Boolean(fieldErrors.country)}
                  />
                  {fieldErrors.country && <span className="error-msg">{fieldErrors.country}</span>}
                </div>
              </>
            )}

            {eventType === 'SALARY_CHANGE' && (
              <div className="form-grid-2">
                <div className="field">
                  <label htmlFor="newSalary">
                    New Annual Salary <span className="required-mark">*</span>
                  </label>
                  <input
                    id="newSalary"
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="75000"
                    value={form.newSalary}
                    onChange={setField('newSalary')}
                    aria-invalid={Boolean(fieldErrors.newSalary)}
                  />
                  {fieldErrors.newSalary && (
                    <span className="error-msg">{fieldErrors.newSalary}</span>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="currency">
                    Currency (ISO 4217) <span className="required-mark">*</span>
                  </label>
                  <input
                    id="currency"
                    type="text"
                    className="mono"
                    placeholder="EUR"
                    maxLength={3}
                    value={form.currency}
                    onChange={setField('currency')}
                    aria-invalid={Boolean(fieldErrors.currency)}
                  />
                  {fieldErrors.currency && <span className="error-msg">{fieldErrors.currency}</span>}
                </div>
              </div>
            )}
          </div>

          {/* Section 4: Idempotency Key */}
          <div className="form-section">
            <span className="form-section__title">4. Idempotency Protection</span>
            <div className="field">
              <label htmlFor="idempotencyKey">
                Idempotency-Key Header <span className="required-mark">*</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="idempotencyKey"
                  type="text"
                  className="mono"
                  value={form.idempotencyKey}
                  onChange={setField('idempotencyKey')}
                  aria-invalid={Boolean(fieldErrors.idempotencyKey)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleRegenerateKey}
                  title="Generate a fresh UUID for this submission"
                >
                  Generate New
                </button>
              </div>
              {fieldErrors.idempotencyKey && (
                <span className="error-msg">{fieldErrors.idempotencyKey}</span>
              )}
              <span className="hint-text">
                Submitting the same key twice returns the original event without duplicate processing.
              </span>
            </div>
          </div>

          {submitError && (
            <div className="banner banner-error" role="alert">
              <strong>Submission Rejected:</strong> {submitError}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 8 }}>
            <Link href="/events/" className="btn btn-secondary">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="spinner spinner-header" aria-hidden="true" />
                  Accepting Event…
                </>
              ) : (
                'Dispatch Event (HTTP 202) →'
              )}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
