'use client';

import { useCallback, useEffect, useState } from 'react';
import { getHealth } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import type { HealthResponse } from '../../lib/types';

export default function HealthPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await getHealth();
      setHealth(res);
      setError(null);
      setLastChecked(new Date().toISOString());
    } catch {
      setError('Failed to query backend health endpoint.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const isDegraded = error != null || health?.status !== 'ok';

  return (
    <>
      <div className="page-header">
        <div className="page-header__meta">
          <h1>System Infrastructure Health</h1>
          <p className="page-header__desc">
            Direct dependency health and connectivity status reported by <code>GET /health</code>.
          </p>
        </div>
        <div className="page-header__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={checkHealth}
            disabled={loading}
          >
            {loading ? <span className="spinner" aria-hidden="true" /> : '↻ Refresh Status'}
          </button>
        </div>
      </div>

      {/* Overall Health Banner */}
      {isDegraded ? (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>System Degraded:</strong> One or more critical backend dependencies are unreachable or reporting failure.
          </div>
        </div>
      ) : (
        <div className="banner banner-success" role="status">
          <div>
            <strong>All Systems Operational:</strong> API gateway, PostgreSQL database, and Redis execution engine are healthy.
          </div>
        </div>
      )}

      {/* Dependency Health Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {/* Service 1: API Server */}
        <div className="card card-padded">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>NestJS REST API</span>
            <span className="badge badge-succeeded">
              <span className="badge-dot" /> Operational
            </span>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 12 }}>
            Handles incoming HTTP requests, idempotency enforcement, and validation pipes.
          </p>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Protocol: HTTP/1.1 (JSON)
          </div>
        </div>

        {/* Service 2: PostgreSQL */}
        <div className="card card-padded">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>PostgreSQL Database</span>
            {health?.dependencies.postgres === 'up' ? (
              <span className="badge badge-succeeded">
                <span className="badge-dot" /> Connected (Up)
              </span>
            ) : (
              <span className="badge badge-failed">
                <span className="badge-dot" /> Disconnected (Down)
              </span>
            )}
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 12 }}>
            Persistent transactional storage for event envelopes, status audit logs, and per-employee advisory locks.
          </p>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Engine: PostgreSQL 16 (Prisma ORM)
          </div>
        </div>

        {/* Service 3: Redis / BullMQ */}
        <div className="card card-padded">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>Redis / BullMQ Engine</span>
            {health?.dependencies.redis === 'up' ? (
              <span className="badge badge-succeeded">
                <span className="badge-dot" /> Connected (Up)
              </span>
            ) : (
              <span className="badge badge-failed">
                <span className="badge-dot" /> Disconnected (Down)
              </span>
            )}
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 12 }}>
            Asynchronous job queue for background dispatching, worker concurrency, and exponential retry backoff.
          </p>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Engine: Redis 7 (BullMQ)
          </div>
        </div>
      </div>

      {/* Inspection Details Card */}
      <div className="card card-padded" style={{ marginTop: 16 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>
          Health Telemetry Metadata
        </div>
        <div className="detail-specs-grid">
          <div className="spec-item">
            <span className="spec-item__label">Backend Status Code</span>
            <span className="spec-item__value mono">{health?.status ?? 'error'}</span>
          </div>
          <div className="spec-item">
            <span className="spec-item__label">Last Health Query</span>
            <span className="spec-item__value">
              {lastChecked ? `${formatDateTime(lastChecked)} (${formatRelative(lastChecked)})` : 'Polling…'}
            </span>
          </div>
          <div className="spec-item">
            <span className="spec-item__label">Health Polling Cadence</span>
            <span className="spec-item__value">Every 10 seconds</span>
          </div>
        </div>
      </div>
    </>
  );
}
