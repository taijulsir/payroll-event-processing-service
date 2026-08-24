'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, getEvent } from '../../lib/api';
import { formatDateTime, formatEventType, formatRelative, formatSequence } from '../../lib/format';
import type { PayrollEventDetail } from '../../lib/types';
import { StatusBadge } from '../../components/StatusBadge';
import { CopyButton } from '../../components/CopyButton';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // 2 minutes maximum polling
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);

export default function EventDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="state-box">
          <span className="spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
          <p className="state-box__title">Loading Event Details…</p>
        </div>
      }
    >
      <EventDetailContent />
    </Suspense>
  );
}

function EventDetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const justSubmitted = searchParams.get('justSubmitted') === '1';

  const [event, setEvent] = useState<PayrollEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    setError(null);
    setNotFound(false);
    setPollExhausted(false);

    const fetchOnce = async () => {
      try {
        const data = await getEvent(id);
        if (cancelled) return;
        setEvent(data);
        setLoading(false);

        if (TERMINAL_STATUSES.has(data.status)) {
          return; // Reached terminal state (SUCCEEDED or FAILED)
        }

        attempts += 1;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setPollExhausted(true);
          return;
        }

        timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof ApiError ? err.message : 'Failed to retrieve event from server.');
        }
      }
    };

    fetchOnce();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, pollGeneration]);

  const resumePolling = () => {
    setPollGeneration((g) => g + 1);
  };

  if (!id) {
    return (
      <div className="card card-padded state-box">
        <p className="state-box__title" style={{ color: 'var(--status-failed-text)' }}>
          Invalid Request
        </p>
        <p className="state-box__desc">No event identifier was provided in query parameters.</p>
        <Link href="/" className="btn btn-secondary">
          ← Back to Events
        </Link>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="card card-padded state-box">
        <p className="state-box__title" style={{ color: 'var(--status-failed-text)' }}>
          Event Not Found
        </p>
        <p className="state-box__desc">No payroll event was found matching ID: {id}</p>
        <Link href="/" className="btn btn-secondary">
          ← Back to Events
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card card-padded state-box">
        <p className="state-box__title" style={{ color: 'var(--status-failed-text)' }}>
          Connection Error
        </p>
        <p className="state-box__desc">{error}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={resumePolling}>
            Retry Request
          </button>
          <Link href="/" className="btn btn-secondary btn-sm">
            Back to Events
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !event) {
    return (
      <div className="state-box">
        <span className="spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
        <p className="state-box__title">Retrieving Event Telemetry…</p>
        <p className="state-box__desc mono">{id}</p>
      </div>
    );
  }

  const isPending = event.status === 'PENDING';
  const isProcessing = event.status === 'PROCESSING';
  const isSucceeded = event.status === 'SUCCEEDED';
  const isFailed = event.status === 'FAILED';
  const isTerminal = isSucceeded || isFailed;

  const resultObj = event.result && typeof event.result === 'object' ? (event.result as Record<string, unknown>) : null;

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1>Event Inspection</h1>
            <span className="sequence-badge" title="Per-employee FIFO sequence number">
              {formatSequence(event.sequence)}
            </span>
            <StatusBadge status={event.status} failureType={event.failureType} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              Event ID: {event.id}
            </span>
            <CopyButton text={event.id} label="Copy ID" />
          </div>
        </div>
        <div className="page-header__actions">
          <Link href="/" className="btn btn-secondary btn-sm">
            ← Back to Stream
          </Link>
        </div>
      </div>

      {justSubmitted && (
        <div className="banner banner-success" role="status">
          <div>
            <strong>Event Accepted (HTTP 202):</strong> Persisted in PostgreSQL database and enqueued into BullMQ queue. Watching for worker execution below.
          </div>
        </div>
      )}

      {!isTerminal && !pollExhausted && (
        <div className="banner banner-info" role="status">
          <span className="spinner" aria-hidden="true" style={{ marginTop: 2 }} />
          <div>
            <strong>Live Polling Active:</strong> Monitoring processing status every 2 seconds. The view updates automatically as the worker processes the event.
          </div>
        </div>
      )}

      {pollExhausted && (
        <div className="banner banner-warning" role="alert">
          <div>
            <strong>Auto-polling paused:</strong> Event is still in {event.status} state after 2 minutes.
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={resumePolling}
            style={{ marginLeft: 'auto' }}
          >
            Resume Polling
          </button>
        </div>
      )}

      {/* Lifecycle Stage Progression Bar */}
      <div className="lifecycle-pipeline">
        <div className={`pipeline-step ${isPending ? 'is-active' : 'is-succeeded'}`}>
          <div className="pipeline-step__num">{isPending ? '1' : '✓'}</div>
          <div className="pipeline-step__content">
            <span className="pipeline-step__label">1. Accepted & Enqueued</span>
            <span className="pipeline-step__sub">{formatRelative(event.submittedAt)}</span>
          </div>
        </div>

        <div
          className={`pipeline-step ${
            isProcessing
              ? 'is-active'
              : isTerminal
              ? 'is-succeeded'
              : ''
          }`}
        >
          <div className="pipeline-step__num">
            {isProcessing ? (
              <span className="spinner spinner-header" style={{ width: 12, height: 12 }} />
            ) : isTerminal ? (
              '✓'
            ) : (
              '2'
            )}
          </div>
          <div className="pipeline-step__content">
            <span className="pipeline-step__label">2. Worker Execution</span>
            <span className="pipeline-step__sub">
              {event.processingStartedAt
                ? `Started ${formatRelative(event.processingStartedAt)}`
                : 'Awaiting worker claim'}
            </span>
          </div>
        </div>

        <div
          className={`pipeline-step ${
            isSucceeded
              ? 'is-succeeded'
              : isFailed
              ? 'is-failed'
              : ''
          }`}
        >
          <div className="pipeline-step__num">
            {isSucceeded ? '✓' : isFailed ? '✕' : '3'}
          </div>
          <div className="pipeline-step__content">
            <span className="pipeline-step__label">
              3. Outcome ({isSucceeded ? 'Succeeded' : isFailed ? 'Failed' : 'Pending'})
            </span>
            <span className="pipeline-step__sub">
              {event.processingFinishedAt
                ? `Finished ${formatRelative(event.processingFinishedAt)}`
                : 'Pending provider result'}
            </span>
          </div>
        </div>
      </div>

      {/* Failure Diagnostic Alert */}
      {isFailed && event.failureReason && (
        <div className="banner banner-error" role="alert">
          <div>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>
              Processing Failed — {event.failureType === 'RETRYABLE' ? 'Retries Exhausted' : 'Permanent Provider Rejection'}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
              {event.failureReason}
            </div>
          </div>
        </div>
      )}

      {/* Section 1: Event Overview & Metadata (Full Exact Identifiers) */}
      <div className="card card-padded">
        <div className="card-title" style={{ marginBottom: 16 }}>
          1. Event Overview & Identifiers
        </div>
        <div className="detail-specs-grid">
          <div className="spec-item" style={{ gridColumn: 'span 2' }}>
            <span className="spec-item__label">Employee ID (Full Exact Identifier)</span>
            <div className="spec-item__value-row">
              <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {event.employeeId}
              </span>
              <CopyButton text={event.employeeId} label="Copy ID" />
            </div>
          </div>

          <div className="spec-item">
            <span className="spec-item__label">Event Type</span>
            <span className="spec-item__value">{formatEventType(event.eventType)}</span>
          </div>

          <div className="spec-item">
            <span className="spec-item__label">Sequence Order</span>
            <span className="spec-item__value mono">{formatSequence(event.sequence)}</span>
          </div>

          <div className="spec-item">
            <span className="spec-item__label">Processing Attempts</span>
            <span className="spec-item__value mono">
              {event.attempts} of {event.maxAttempts} max
            </span>
          </div>

          <div className="spec-item" style={{ gridColumn: 'span 2' }}>
            <span className="spec-item__label">Idempotency Key</span>
            <div className="spec-item__value-row">
              <span className="mono" style={{ fontSize: '0.8125rem' }}>
                {event.idempotencyKey}
              </span>
              <CopyButton text={event.idempotencyKey} label="Copy Key" />
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Processing Timestamps */}
      <div className="card card-padded">
        <div className="card-title" style={{ marginBottom: 16 }}>
          2. Processing Timestamps
        </div>
        <div className="detail-specs-grid">
          <div className="spec-item">
            <span className="spec-item__label">Submitted At</span>
            <span className="spec-item__value" title={event.submittedAt}>
              {formatDateTime(event.submittedAt)}
              <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                ({formatRelative(event.submittedAt)})
              </span>
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-item__label">Processing Started</span>
            <span className="spec-item__value">
              {event.processingStartedAt ? (
                <>
                  {formatDateTime(event.processingStartedAt)}
                  <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    ({formatRelative(event.processingStartedAt)})
                  </span>
                </>
              ) : (
                '—'
              )}
            </span>
          </div>

          <div className="spec-item">
            <span className="spec-item__label">Processing Finished</span>
            <span className="spec-item__value">
              {event.processingFinishedAt ? (
                <>
                  {formatDateTime(event.processingFinishedAt)}
                  <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    ({formatRelative(event.processingFinishedAt)})
                  </span>
                </>
              ) : (
                '—'
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Section 3 & 4: Payload & Provider Result */}
      <div style={{ display: 'grid', gridTemplateColumns: event.result != null ? 'repeat(2, 1fr)' : '1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header">
            <span className="card-title">3. Event Payload</span>
            <span className="employee-pill mono" style={{ fontSize: '0.75rem' }}>
              {event.eventType}
            </span>
          </div>
          <div style={{ padding: 16 }}>
            <pre className="code-viewer">{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        </div>

        {event.result != null && (
          <div className="card">
            <div className="card-header">
              <span className="card-title" style={{ color: 'var(--status-succeeded-text)' }}>
                4. Provider Result
              </span>
              <span className="badge badge-succeeded">Applied</span>
            </div>
            <div style={{ padding: 16 }}>
              {typeof resultObj?.providerReference === 'string' && (
                <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>Reference:</span>
                  <span className="mono" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                    {resultObj.providerReference}
                  </span>
                  <CopyButton text={resultObj.providerReference} label="Copy Ref" />
                </div>
              )}
              <pre className="code-viewer">{JSON.stringify(event.result, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>

      {/* Section 5: State Transition History / Audit Trail */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">5. State Transition Audit Trail</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {event.statusHistory.length} Recorded Transition{event.statusHistory.length === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ padding: '20px 24px' }}>
          {event.statusHistory.length === 0 ? (
            <div className="state-box">
              <p className="state-box__desc">No state transition history recorded.</p>
            </div>
          ) : (
            <ul className="timeline-list">
              {event.statusHistory.map((entry) => {
                const nodeClass =
                  entry.toStatus === 'SUCCEEDED'
                    ? 'node-succeeded'
                    : entry.toStatus === 'FAILED'
                    ? 'node-failed'
                    : entry.toStatus === 'PROCESSING'
                    ? 'node-processing'
                    : 'node-pending';

                return (
                  <li key={entry.id} className="timeline-item">
                    <span className={`timeline-node ${nodeClass}`} aria-hidden="true" />
                    <div className="timeline-body">
                      <div className="timeline-header-line">
                        <span className="timeline-transition">
                          {entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : `Created as ${entry.toStatus}`}
                        </span>
                        {entry.attemptNumber != null && (
                          <span className="timeline-attempt-pill">
                            Attempt #{entry.attemptNumber}
                          </span>
                        )}
                        <span className="timeline-time" title={entry.occurredAt}>
                          {formatDateTime(entry.occurredAt)} ({formatRelative(entry.occurredAt)})
                        </span>
                      </div>
                      {entry.errorMessage && (
                        <div className="timeline-error-callout">
                          <strong>Failure Reason:</strong> {entry.errorMessage}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
