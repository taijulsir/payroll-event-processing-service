'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, submitEvent } from '../../lib/api';
import { EVENT_TYPES, type EventType, type SubmitEventInput } from '../../lib/types';
import { formatEventType } from '../../lib/format';

// Mirrors backend/src/event-types/*.dto.ts field-by-field validation closely enough to catch
// obvious mistakes before a round trip — the backend remains authoritative (this is a UX
// improvement only; every rule here is re-checked server-side regardless).
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
}

const EMPTY_FORM: FormState = {
  employeeId: '',
  effectiveDate: '',
  iban: '',
  street: '',
  city: '',
  postalCode: '',
  country: '',
  newSalary: '',
  currency: '',
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

  if (eventType === 'BANK_ACCOUNT_CHANGE') {
    if (!form.iban.trim()) errors.iban = 'IBAN is required.';
    else if (!IBAN_PATTERN.test(form.iban.trim().toUpperCase())) {
      errors.iban = 'IBAN must be a plausible IBAN (e.g. DE89370400440532013000).';
    }
  }

  if (eventType === 'ADDRESS_CHANGE') {
    if (!form.street.trim()) errors.street = 'Street is required.';
    if (!form.city.trim()) errors.city = 'City is required.';
    if (!form.postalCode.trim()) errors.postalCode = 'Postal code is required.';
    if (!form.country.trim()) errors.country = 'Country is required.';
  }

  if (eventType === 'SALARY_CHANGE') {
    const salary = Number(form.newSalary);
    if (!form.newSalary.trim() || Number.isNaN(salary)) {
      errors.newSalary = 'New salary must be a number.';
    } else if (salary <= 0) {
      errors.newSalary = 'New salary must be greater than zero.';
    }
    if (!form.currency.trim()) errors.currency = 'Currency is required.';
    else if (!CURRENCY_PATTERN.test(form.currency.trim().toUpperCase())) {
      errors.currency = 'Currency must be a 3-letter ISO 4217 code (e.g. EUR, USD).';
    }
  }

  return errors;
}

export default function SubmitEventPage() {
  const router = useRouter();
  const [eventType, setEventType] = useState<EventType>('ADDRESS_CHANGE');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const errors = validate(eventType, form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `frontend-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = buildPayload(eventType, form);
      const created = await submitEvent(idempotencyKey, payload);
      router.push(`/event?id=${encodeURIComponent(created.id)}&justSubmitted=1`);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.details?.length ? err.details.join(' ') : err.message);
      } else {
        setSubmitError('Something went wrong submitting this event.');
      }
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Submit Payroll Event</h1>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="eventType">Event type</label>
            <select
              id="eventType"
              value={eventType}
              onChange={(e) => {
                setEventType(e.target.value as EventType);
                setFieldErrors({});
              }}
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {formatEventType(t)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-grid">
            <TextField
              id="employeeId"
              label="Employee ID"
              value={form.employeeId}
              onChange={setField('employeeId')}
              error={fieldErrors.employeeId}
            />
            <div className="field">
              <label htmlFor="effectiveDate">Effective date</label>
              <input
                id="effectiveDate"
                type="date"
                value={form.effectiveDate}
                onChange={setField('effectiveDate')}
                aria-invalid={Boolean(fieldErrors.effectiveDate)}
                aria-describedby={fieldErrors.effectiveDate ? 'effectiveDate-error' : undefined}
              />
              {fieldErrors.effectiveDate && (
                <p id="effectiveDate-error" className="error">
                  {fieldErrors.effectiveDate}
                </p>
              )}
            </div>
          </div>

          {eventType === 'BANK_ACCOUNT_CHANGE' && (
            <TextField
              id="iban"
              label="IBAN"
              value={form.iban}
              onChange={setField('iban')}
              error={fieldErrors.iban}
              placeholder="DE89370400440532013000"
            />
          )}

          {eventType === 'ADDRESS_CHANGE' && (
            <>
              <TextField
                id="street"
                label="Street"
                value={form.street}
                onChange={setField('street')}
                error={fieldErrors.street}
              />
              <div className="form-grid">
                <TextField
                  id="city"
                  label="City"
                  value={form.city}
                  onChange={setField('city')}
                  error={fieldErrors.city}
                />
                <TextField
                  id="postalCode"
                  label="Postal code"
                  value={form.postalCode}
                  onChange={setField('postalCode')}
                  error={fieldErrors.postalCode}
                />
              </div>
              <TextField
                id="country"
                label="Country"
                value={form.country}
                onChange={setField('country')}
                error={fieldErrors.country}
                placeholder="DE"
              />
            </>
          )}

          {eventType === 'SALARY_CHANGE' && (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="newSalary">New salary</label>
                <input
                  id="newSalary"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.newSalary}
                  onChange={setField('newSalary')}
                  aria-invalid={Boolean(fieldErrors.newSalary)}
                  aria-describedby={fieldErrors.newSalary ? 'newSalary-error' : undefined}
                />
                {fieldErrors.newSalary && (
                  <p id="newSalary-error" className="error">
                    {fieldErrors.newSalary}
                  </p>
                )}
              </div>
              <TextField
                id="currency"
                label="Currency"
                value={form.currency}
                onChange={setField('currency')}
                error={fieldErrors.currency}
                placeholder="EUR"
              />
            </div>
          )}

          {submitError && (
            <div className="banner banner-error" role="alert">
              {submitError}
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Submitting…
              </>
            ) : (
              'Submit Event'
            )}
          </button>
        </form>
      </div>
    </>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} className="error">
          {error}
        </p>
      )}
    </div>
  );
}
