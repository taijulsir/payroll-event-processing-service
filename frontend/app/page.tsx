'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, listEvents } from '../lib/api';
import { formatEventType, formatRelative, formatSequence, formatDateTime } from '../lib/format';
import { EVENT_STATUSES, type PayrollEvent } from '../lib/types';
import { StatusBadge } from '../components/StatusBadge';

const PAGE_SIZE = 20;
const AUTO_REFRESH_MS = 5000;

export default function EventsListPage() {
  const router = useRouter();
  const openEvent = useCallback(
    (id: string) => router.push(`/event/?id=${encodeURIComponent(id)}`),
    [router],
  );

  const [items, setItems] = useState<PayrollEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  // Live filter input states
  const [employeeIdFilter, setEmployeeIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Applied filters sent strictly to backend API query
  const [appliedFilters, setAppliedFilters] = useState<{ employeeId: string; status: string }>({
    employeeId: '',
    status: '',
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  /**
   * Loads events from the backend via GET /events using server-side query parameters:
   * employeeId, status, limit, offset.
   */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const response = await listEvents({
          employeeId: appliedFilters.employeeId ? appliedFilters.employeeId.trim() : undefined,
          status: appliedFilters.status ? appliedFilters.status : undefined,
          limit: PAGE_SIZE,
          offset,
        });
        setItems(response.items);
        setTotal(response.total);
        setLastLoadedAt(new Date().toISOString());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to fetch events from backend API.');
      } finally {
        setLoading(false);
      }
    },
    [appliedFilters, offset],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Light polling for list updates every 5 seconds
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const interval = setInterval(() => loadRef.current(true), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setAppliedFilters({
      employeeId: employeeIdFilter.trim(),
      status: statusFilter,
    });
  };

  const handleClearFilters = () => {
    setEmployeeIdFilter('');
    setStatusFilter('');
    setOffset(0);
    setAppliedFilters({ employeeId: '', status: '' });
  };

  const hasActiveFilters = Boolean(appliedFilters.employeeId || appliedFilters.status);
  const canGoNext = offset + PAGE_SIZE < total;
  const canGoPrev = offset > 0;

  // Real count of in-flight active events on the current page slice
  const activeInFlightCount = items.filter(
    (i) => i.status === 'PENDING' || i.status === 'PROCESSING',
  ).length;

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <h1>Payroll Event Stream</h1>
          <p className="page-header__desc">
            Asynchronous audit log of payroll-related mutations, per-employee sequence ordering, and provider outcomes.
          </p>
        </div>
        <div className="page-header__actions">
          <Link href="/submit/" className="btn btn-primary">
            + Submit Event
          </Link>
        </div>
      </div>

      {/* Summary Metrics Bar — backed strictly by real API data */}
      <div className="summary-grid">
        <div className="summary-card">
          <span className="summary-card__label">Total Events</span>
          <span className="summary-card__value mono">{total}</span>
          <span className="summary-card__sub">
            {hasActiveFilters ? 'Matching current criteria' : 'Total events recorded in database'}
          </span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">Active On Page</span>
          <span
            className="summary-card__value mono"
            style={{ color: activeInFlightCount > 0 ? 'var(--primary)' : 'inherit' }}
          >
            {activeInFlightCount}
          </span>
          <span className="summary-card__sub">Pending queue or worker processing</span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">Feed Polling</span>
          <span className="summary-card__value" style={{ fontSize: '1rem', fontWeight: 600 }}>
            {lastLoadedAt ? `Updated ${formatRelative(lastLoadedAt)}` : 'Live'}
          </span>
          <span className="summary-card__sub">Auto-polled every 5 seconds</span>
        </div>
      </div>

      {/* Server-Side Filtering Toolbar */}
      <div className="toolbar-card">
        <form className="toolbar-form" onSubmit={handleApplyFilters} role="search">
          <div className="filter-group">
            <div className="filter-input-wrap">
              <label htmlFor="filter-employee" className="visually-hidden">
                Filter by Employee ID
              </label>
              <input
                id="filter-employee"
                type="text"
                className="filter-input"
                placeholder="Filter by Employee ID (e.g. emp-1001)"
                value={employeeIdFilter}
                onChange={(e) => setEmployeeIdFilter(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="filter-status" className="visually-hidden">
                Filter by Status
              </label>
              <select
                id="filter-status"
                className="filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All Statuses</option>
                {EVENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <button type="submit" className="btn btn-secondary btn-sm">
              Apply Filters
            </button>

            {hasActiveFilters && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleClearFilters}>
                Reset
              </button>
            )}
          </div>

          <div className="toolbar-status">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => load()}
              disabled={loading}
              title="Query backend for updates"
            >
              {loading ? <span className="spinner" aria-hidden="true" /> : '↻ Refresh'}
            </button>
          </div>
        </form>
      </div>

      {/* Data Table Container */}
      <div className="card">
        {error ? (
          <div className="state-box">
            <p className="state-box__title" style={{ color: 'var(--status-failed-text)' }}>
              Error Loading Events
            </p>
            <p className="state-box__desc">{error}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
              Try Again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="state-box">
            <span className="spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
            <p className="state-box__title">Querying Event Stream…</p>
            <p className="state-box__desc">Fetching audit records from PostgreSQL database.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="state-box">
            <p className="state-box__title">No Events Found</p>
            <p className="state-box__desc">
              {hasActiveFilters
                ? 'No events match the selected filters. Try clearing the filter parameters.'
                : 'No payroll events have been submitted yet.'}
            </p>
            {hasActiveFilters ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleClearFilters}>
                Clear Active Filters
              </button>
            ) : (
              <Link href="/submit/" className="btn btn-primary btn-sm">
                Submit Your First Event
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '22%' }}>Employee ID</th>
                    <th style={{ width: '20%' }}>Event Type</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>Sequence</th>
                    <th style={{ width: '18%' }}>Lifecycle Status</th>
                    <th style={{ width: '10%', textAlign: 'center' }}>Attempts</th>
                    <th style={{ width: '10%' }}>Submitted</th>
                    <th style={{ width: '10%', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((event) => (
                    <tr
                      key={event.id}
                      onClick={() => openEvent(event.id)}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open event details for ${event.employeeId} (${event.eventType})`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openEvent(event.id);
                        }
                      }}
                    >
                      <td>
                        <span className="employee-pill" title={event.employeeId}>
                          {event.employeeId}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 500 }}>{formatEventType(event.eventType)}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="sequence-badge" title="Per-employee FIFO sequence position">
                          {formatSequence(event.sequence)}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={event.status} failureType={event.failureType} />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="attempts-text">
                          {event.attempts} / {event.maxAttempts}
                        </span>
                      </td>
                      <td>
                        <span title={formatDateTime(event.submittedAt)} style={{ color: 'var(--text-secondary)' }}>
                          {formatRelative(event.submittedAt)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="action-link">
                          View details →
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Server-Side Pagination Footer */}
            <div className="pagination-footer">
              <div>
                Showing <strong className="mono">{total === 0 ? 0 : offset + 1}</strong> –{' '}
                <strong className="mono">{Math.min(offset + PAGE_SIZE, total)}</strong> of{' '}
                <strong className="mono">{total}</strong> events
              </div>
              <div className="pagination-controls">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!canGoPrev || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  ← Previous
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!canGoNext || loading}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
