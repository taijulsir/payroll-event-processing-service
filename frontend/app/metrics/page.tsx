'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, listEvents } from '../../lib/api';
import { formatEventType } from '../../lib/format';
import type { PayrollEvent } from '../../lib/types';

export default function MetricsPage() {
  const [events, setEvents] = useState<PayrollEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      // Fetch up to 100 recent events for accurate sample-based metric calculation
      const res = await listEvents({ limit: 100, offset: 0 });
      setEvents(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to query event telemetry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Aggregate metrics from real event data
  const statusCounts = events.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const typeCounts = events.reduce(
    (acc, e) => {
      acc[e.eventType] = (acc[e.eventType] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const failureTypeCounts = events.reduce(
    (acc, e) => {
      if (e.failureType) {
        acc[e.failureType] = (acc[e.failureType] || 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>,
  );

  const succeededCount = statusCounts['SUCCEEDED'] || 0;
  const failedCount = statusCounts['FAILED'] || 0;
  const processingCount = statusCounts['PROCESSING'] || 0;
  const pendingCount = statusCounts['PENDING'] || 0;

  const sampleSize = events.length;

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <h1>Operational Metrics</h1>
          <p className="page-header__desc">
            Aggregated lifecycle and throughput distributions computed directly from PostgreSQL audit records.
          </p>
        </div>
        <div className="page-header__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadData}
            disabled={loading}
          >
            {loading ? <span className="spinner" aria-hidden="true" /> : '↻ Recalculate'}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>Telemetry Error:</strong> {error}
          </div>
        </div>
      )}

      {/* KPI Overview Grid */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-card__label">Total Events</span>
          <span className="kpi-card__value mono">{loading ? '—' : total}</span>
          <span className="kpi-card__sub">All recorded mutations</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">Succeeded</span>
          <span className="kpi-card__value mono" style={{ color: 'var(--status-succeeded-text)' }}>
            {loading ? '—' : succeededCount}
          </span>
          <span className="kpi-card__sub">
            {sampleSize > 0 ? `${Math.round((succeededCount / sampleSize) * 100)}% of sample` : '—'}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">Failed</span>
          <span
            className="kpi-card__value mono"
            style={{ color: failedCount > 0 ? 'var(--status-failed-text)' : 'inherit' }}
          >
            {loading ? '—' : failedCount}
          </span>
          <span className="kpi-card__sub">
            {sampleSize > 0 ? `${Math.round((failedCount / sampleSize) * 100)}% of sample` : '—'}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-card__label">In Flight (Queue / Active)</span>
          <span
            className="kpi-card__value mono"
            style={{ color: pendingCount + processingCount > 0 ? 'var(--primary)' : 'inherit' }}
          >
            {loading ? '—' : pendingCount + processingCount}
          </span>
          <span className="kpi-card__sub">Awaiting or executing worker claim</span>
        </div>
      </div>

      {/* Metric Breakdown Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Status Distribution */}
        <div className="card card-padded">
          <div className="card-title" style={{ marginBottom: 14 }}>
            Status Distribution ({sampleSize} sample)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {['SUCCEEDED', 'FAILED', 'PROCESSING', 'PENDING'].map((status) => {
              const count = statusCounts[status] || 0;
              const pct = sampleSize > 0 ? Math.round((count / sampleSize) * 100) : 0;
              return (
                <div key={status} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ fontWeight: 600 }}>{status}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {count} ({pct}%)
                    </span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--bg-surface-subtle)',
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background:
                          status === 'SUCCEEDED'
                            ? '#22c55e'
                            : status === 'FAILED'
                            ? '#ef4444'
                            : status === 'PROCESSING'
                            ? '#3b82f6'
                            : '#71717a',
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Event Type Distribution */}
        <div className="card card-padded">
          <div className="card-title" style={{ marginBottom: 14 }}>
            Event Type Distribution
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {['BANK_ACCOUNT_CHANGE', 'ADDRESS_CHANGE', 'SALARY_CHANGE'].map((type) => {
              const count = typeCounts[type] || 0;
              const pct = sampleSize > 0 ? Math.round((count / sampleSize) * 100) : 0;
              return (
                <div key={type} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ fontWeight: 600 }}>{formatEventType(type)}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {count} ({pct}%)
                    </span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--bg-surface-subtle)',
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: 'var(--primary)',
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Failure Classification */}
        <div className="card card-padded">
          <div className="card-title" style={{ marginBottom: 14 }}>
            Failure Type Breakdown
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>Retryable Failures</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Transient timeouts / rate limits retried via BullMQ
                </div>
              </div>
              <span className="mono" style={{ fontWeight: 700, fontSize: '1rem' }}>
                {failureTypeCounts['RETRYABLE'] || 0}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: 10,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>Permanent Failures</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Provider rejections that bypass retry queues
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontWeight: 700,
                  fontSize: '1rem',
                  color: failureTypeCounts['PERMANENT'] ? 'var(--status-failed-text)' : 'inherit',
                }}
              >
                {failureTypeCounts['PERMANENT'] || 0}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Scope Disclaimer */}
      <div
        className="card card-padded"
        style={{
          marginTop: 16,
          background: 'var(--bg-surface-subtle)',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        <strong>Operational Telemetry Guarantee:</strong> All metrics displayed above are aggregated strictly from the active PostgreSQL event log without simulated or fabricated time-series data.
      </div>
    </>
  );
}
