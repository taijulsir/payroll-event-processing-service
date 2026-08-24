'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, getEvent } from '../../lib/api';
import { formatDateTime, formatEventType } from '../../lib/format';
import type { PayrollEventDetail } from '../../lib/types';
import { StatusBadge } from '../../components/StatusBadge';

// Polling cadence and cap for the detail page's "watch this event finish" behavior. Not the
// same mechanism as the list page's light auto-refresh (app/page.tsx) — this one exists
// specifically to make PENDING -> PROCESSING -> SUCCEEDED|FAILED visible for one event, and
// it stops itself both on reaching a terminal state and after a bounded number of attempts,
// so a genuinely stuck event never polls forever.
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // 2 minutes at the interval above
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);

export default function EventDetailPage() {
  return (
    <Suspense fallback={<p className="state-message">Loading…</p>}>
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
  // Bumping this re-runs the polling effect from scratch — the "Check again" button after
  // MAX_POLL_ATTEMPTS is reached, or a simple way to (re)start watching for `id` changes.
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
          return; // reached SUCCEEDED/FAILED — stop polling, nothing more to do
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
          setError(err instanceof ApiError ? err.message : 'Failed to load this event.');
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
      <div className="card">
        <p className="state-message is-error">No event id was provided.</p>
        <p>
          <Link href="/">Back to events</Link>
        </p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="card">
        <p className="state-message is-error">No event exists with this id.</p>
        <p>
          <Link href="/">Back to events</Link>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <p className="state-message is-error">{error}</p>
        <p>
          <Link href="/">Back to events</Link>
        </p>
      </div>
    );
  }

  if (loading || !event) {
    return (
      <p className="state-message">
        <span className="spinner" aria-hidden="true" /> Loading event…
      </p>
    );
  }

  const isActive = !TERMINAL_STATUSES.has(event.status);

  return (
    <>
      <div className="page-header">
        <h1>Event Detail</h1>
        <Link href="/" className="btn btn-secondary">
          Back to events
        </Link>
      </div>

      {justSubmitted && (
        <div className="banner banner-success">
          Event accepted — watching for processing updates below.
        </div>
      )}

      {event.status === 'FAILED' && event.failureReason && (
        <div className="banner banner-error" role="alert">
          <strong>Processing failed{event.failureType ? ` (${event.failureType})` : ''}:</strong>{' '}
          {event.failureReason}
        </div>
      )}

      {isActive && !pollExhausted && (
        <div className="banner banner-info">
          <span className="spinner" aria-hidden="true" style={{ marginRight: 8 }} />
          Watching this event — updates automatically while it processes.
        </div>
      )}

      {pollExhausted && (
        <div className="banner banner-info">
          Still {event.status.toLowerCase()} after a while — automatic updates have paused.{' '}
          <button className="btn btn-secondary" onClick={resumePolling} style={{ marginLeft: 8 }}>
            Check again
          </button>
        </div>
      )}

      <div className="card">
        <div className="detail-grid">
          <DetailItem label="Employee ID" value={event.employeeId} />
          <DetailItem label="Event type" value={formatEventType(event.eventType)} />
          <DetailItem label="Status" value={<StatusBadge status={event.status} />} />
          <DetailItem label="Sequence" value={event.sequence} mono />
          <DetailItem label="Attempts" value={`${event.attempts} / ${event.maxAttempts}`} />
          <DetailItem label="Failure type" value={event.failureType ?? '—'} />
          <DetailItem label="Submitted" value={formatDateTime(event.submittedAt)} />
          <DetailItem
            label="Processing started"
            value={formatDateTime(event.processingStartedAt)}
          />
          <DetailItem
            label="Processing finished"
            value={formatDateTime(event.processingFinishedAt)}
          />
        </div>
      </div>

      <div className="card">
        <h2>Payload</h2>
        <pre className="json-block">{JSON.stringify(event.payload, null, 2)}</pre>
      </div>

      {event.result != null && (
        <div className="card">
          <h2>Result</h2>
          <pre className="json-block">{JSON.stringify(event.result, null, 2)}</pre>
        </div>
      )}

      <div className="card">
        <h2>Status History</h2>
        {event.statusHistory.length === 0 ? (
          <p className="state-message">No history yet.</p>
        ) : (
          <ul className="timeline">
            {event.statusHistory.map((entry) => (
              <li key={entry.id}>
                <div className="ts">{formatDateTime(entry.occurredAt)}</div>
                <div className="transition">
                  {entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : entry.toStatus}
                  {entry.attemptNumber != null ? ` (attempt ${entry.attemptNumber})` : ''}
                </div>
                {entry.errorMessage && <div>{entry.errorMessage}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DetailItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="detail-item">
      <div className="label">{label}</div>
      <div className={`value${mono ? ' mono' : ''}`}>{value}</div>
    </div>
  );
}
