'use client';

import { useEffect, useState } from 'react';
import { getHealth } from '../lib/api';
import type { HealthResponse } from '../lib/types';

export function SystemHealthPill() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const check = async () => {
      try {
        const res = await getHealth();
        if (isMounted) {
          setHealth(res);
          setError(false);
        }
      } catch {
        if (isMounted) {
          setError(true);
        }
      }
    };

    check();
    const timer = setInterval(check, 15000);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  if (error || (health && health.status !== 'ok')) {
    return (
      <div className="health-status-badge is-degraded" title="Backend API or dependencies reporting degraded state">
        <span className="badge-dot" style={{ background: '#ef4444' }} />
        <span>API Degraded</span>
      </div>
    );
  }

  if (health?.status === 'ok') {
    return (
      <div className="health-status-badge is-ok" title="Backend API and database connections operational">
        <span className="badge-dot" style={{ background: '#10b981' }} />
        <span>API Connected</span>
      </div>
    );
  }

  return (
    <div className="health-status-badge" title="Connecting to backend API...">
      <span className="badge-dot" style={{ background: '#94a3b8' }} />
      <span>Connecting…</span>
    </div>
  );
}
