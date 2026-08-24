'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, getHealth, listEvents } from '../lib/api';
import { formatEventType, formatSequence } from '../lib/format';
import type { HealthResponse, PayrollEvent } from '../lib/types';
import { StatusBadge } from '../components/StatusBadge';

export default function DashboardPage() {
  const router = useRouter();
  const [events, setEvents] = useState<PayrollEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [eventsRes, healthRes] = await Promise.all([
        listEvents({ limit: 8, offset: 0 }),
        getHealth().catch(() => null),
      ]);
      setEvents(eventsRes.items);
      setTotal(eventsRes.total);
      setHealth(healthRes);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to retrieve dashboard metrics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  const activeCount = events.filter((e) => e.status === 'PENDING' || e.status === 'PROCESSING').length;
  const succeededCount = events.filter((e) => e.status === 'SUCCEEDED').length;
  const failedCount = events.filter((e) => e.status === 'FAILED').length;

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <h1>Operations Dashboard</h1>
          <p className="page-header__desc">
            Real-time overview of the asynchronous payroll mutation stream and backend dependencies.
          </p>
        </div>
        <div className="page-header__actions">
          <Link href="/submit/" className="btn btn-primary">
            + Submit Event
          </Link>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>Dashboard Error:</strong> {error}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadData}
            style={{ marginLeft: 'auto' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Real KPI Metrics Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-card__label">Total Events</span>
          <span className="kpi-card__value mono">{loading ? '—' : total}</span>
          <span className="kpi-card__sub">Audit records in database</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">Active In Flight</span>
          <span
            className="kpi-card__value mono"
            style={{ color: activeCount > 0 ? 'var(--primary)' : 'inherit' }}
          >
            {loading ? '—' : activeCount}
          </span>
          <span className="kpi-card__sub">Pending queue or worker claim</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">Recent Succeeded</span>
          <span className="kpi-card__value mono" style={{ color: 'var(--status-succeeded-text)' }}>
            {loading ? '—' : succeededCount}
          </span>
          <span className="kpi-card__sub">Completed provider sync</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">Recent Failures</span>
          <span
            className="kpi-card__value mono"
            style={{ color: failedCount > 0 ? 'var(--status-failed-text)' : 'inherit' }}
          >
            {loading ? '—' : failedCount}
          </span>
          <span className="kpi-card__sub">Permanent or retry-exhausted</span>
        </div>
      </div>

      {/* Main Grid: Recent Events Stream + Infrastructure Health */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16 }}>
        {/* Recent Events Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Event Stream</span>
            <Link href="/events/" className="action-link">
              View all events ({total}) →
            </Link>
          </div>

          {loading && events.length === 0 ? (
            <div className="state-box">
              <span className="spinner" aria-hidden="true" />
              <p className="state-box__title">Querying Event Stream…</p>
            </div>
          ) : events.length === 0 ? (
            <div className="state-box">
              <p className="state-box__title">No Events Recorded</p>
              <p className="state-box__desc">Submit your first payroll modification to start the stream.</p>
              <Link href="/submit/" className="btn btn-primary btn-sm">
                Submit First Event
              </Link>
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '25%' }}>Employee</th>
                    <th style={{ width: '25%' }}>Event Type</th>
                    <th style={{ width: '15%', textAlign: 'center' }}>Sequence</th>
                    <th style={{ width: '20%' }}>Status</th>
                    <th style={{ width: '15%', textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr
                      key={event.id}
                      onClick={() => router.push(`/event/?id=${encodeURIComponent(event.id)}`)}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open details for ${event.employeeId}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          router.push(`/event/?id=${encodeURIComponent(event.id)}`);
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
                        <span className="sequence-badge" title="Per-employee sequence">
                          {formatSequence(event.sequence)}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={event.status} failureType={event.failureType} />
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
          )}
        </div>

        {/* System Services Status */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">System Health</span>
            <Link href="/health/" className="action-link">
              Details →
            </Link>
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>HTTP REST API</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>NestJS Application Server</span>
              </div>
              <span className="badge badge-succeeded">
                <span className="badge-dot" /> Online
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 12,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>PostgreSQL</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Event Audit Database</span>
              </div>
              {health?.dependencies.postgres === 'up' ? (
                <span className="badge badge-succeeded">
                  <span className="badge-dot" /> Up
                </span>
              ) : (
                <span className="badge badge-failed">
                  <span className="badge-dot" /> Down
                </span>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 12,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>Redis / BullMQ</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Queue & Execution Engine</span>
              </div>
              {health?.dependencies.redis === 'up' ? (
                <span className="badge badge-succeeded">
                  <span className="badge-dot" /> Up
                </span>
              ) : (
                <span className="badge badge-failed">
                  <span className="badge-dot" /> Down
                </span>
              )}
            </div>

            <div
              style={{
                marginTop: 6,
                padding: '10px 12px',
                background: 'var(--bg-surface-subtle)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
              }}
            >
              Health metrics polled directly from backend <code>GET /health</code>.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
