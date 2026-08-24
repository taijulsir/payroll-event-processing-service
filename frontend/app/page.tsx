'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, listEvents } from '../lib/api';
import { formatEventType, formatRelative } from '../lib/format';
import { EVENT_STATUSES, type PayrollEvent } from '../lib/types';
import { StatusBadge } from '../components/StatusBadge';

const PAGE_SIZE = 20;
// Matches architecture.md §19: "refreshed by polling every few seconds so state changes are
// visibly observable without adding WebSockets/SSE infrastructure." A light, fixed-interval
// refresh, not per-row long-polling — this is the list view, not the detail view's
// terminal-state polling (see app/event/page.tsx).
const AUTO_REFRESH_MS = 5000;

export default function EventsListPage() {
  const router = useRouter();
  const openEvent = useCallback(
    (id: string) => router.push(`/event?id=${encodeURIComponent(id)}`),
    [router],
  );
  const [items, setItems] = useState<PayrollEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [employeeIdFilter, setEmployeeIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  // Filters currently applied to the request in flight / most recently completed — kept
  // separate from the live input state so typing in the filter fields doesn't refetch on
  // every keystroke; a filter only takes effect once "Apply" (or Enter) is used.
  const [appliedFilters, setAppliedFilters] = useState({ employeeId: '', status: '' });

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const response = await listEvents({
          employeeId: appliedFilters.employeeId || undefined,
          status: appliedFilters.status || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        setItems(response.items);
        setTotal(response.total);
        setLastLoadedAt(new Date().toISOString());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load events.');
      } finally {
        setLoading(false);
      }
    },
    [appliedFilters, offset],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Light auto-refresh while this page is open — cleaned up on unmount/dependency change so
  // no timer is ever leaked (e.g. after navigating to Submit or a detail page).
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const interval = setInterval(() => loadRef.current(true), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const applyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setAppliedFilters({ employeeId: employeeIdFilter.trim(), status: statusFilter });
  };

  const clearFilters = () => {
    setEmployeeIdFilter('');
    setStatusFilter('');
    setOffset(0);
    setAppliedFilters({ employeeId: '', status: '' });
  };

  const hasFilters = appliedFilters.employeeId || appliedFilters.status;
  const canGoNext = offset + PAGE_SIZE < total;
  const canGoPrev = offset > 0;

  return (
    <>
      <div className="page-header">
        <h1>Submitted Events</h1>
        <Link href="/submit" className="btn btn-primary">
          Submit Event
        </Link>
      </div>

      <form className="toolbar" onSubmit={applyFilters} role="search">
        <label htmlFor="filter-employee" className="visually-hidden">
          Employee ID
        </label>
        <input
          id="filter-employee"
          type="text"
          placeholder="Filter by employee ID"
          value={employeeIdFilter}
          onChange={(e) => setEmployeeIdFilter(e.target.value)}
        />
        <label htmlFor="filter-status" className="visually-hidden">
          Status
        </label>
        <select
          id="filter-status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {EVENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-secondary">
          Apply
        </button>
        {hasFilters && (
          <button type="button" className="btn btn-secondary" onClick={clearFilters}>
            Clear
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => load()}
          disabled={loading}
          aria-label="Refresh now"
        >
          {loading ? <span className="spinner" aria-hidden="true" /> : 'Refresh'}
        </button>
        {lastLoadedAt && (
          <span className="hint" style={{ marginLeft: 'auto' }}>
            Updated {formatRelative(lastLoadedAt)}
          </span>
        )}
      </form>

      <div className="card" style={{ padding: 0 }}>
        {error ? (
          <p className="state-message is-error">{error}</p>
        ) : loading && items.length === 0 ? (
          <p className="state-message">
            <span className="spinner" aria-hidden="true" /> Loading events…
          </p>
        ) : items.length === 0 ? (
          <p className="state-message">
            {hasFilters
              ? 'No events match these filters.'
              : 'No events submitted yet — try submitting one.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Seq</th>
                  <th>Status</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <EventRow key={event.id} event={event} onOpen={openEvent} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="pagination">
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            className="btn btn-secondary"
            disabled={!canGoPrev}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            className="btn btn-secondary"
            disabled={!canGoNext}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

function EventRow({ event, onOpen }: { event: PayrollEvent; onOpen: (id: string) => void }) {
  const open = () => onOpen(event.id);
  return (
    <tr
      onClick={open}
      tabIndex={0}
      role="link"
      aria-label={`Open event for ${event.employeeId}, ${formatEventType(event.eventType)}, status ${event.status}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <td>{event.employeeId}</td>
      <td>{formatEventType(event.eventType)}</td>
      <td className="mono">{event.sequence}</td>
      <td>
        <StatusBadge status={event.status} />
      </td>
      <td>{formatRelative(event.submittedAt)}</td>
    </tr>
  );
}
