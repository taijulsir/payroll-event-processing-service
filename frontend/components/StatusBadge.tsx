const STATUS_CLASS: Record<string, string> = {
  PENDING: 'badge-pending',
  PROCESSING: 'badge-processing',
  SUCCEEDED: 'badge-succeeded',
  FAILED: 'badge-failed',
};

interface StatusBadgeProps {
  status: string;
  failureType?: string | null;
}

/**
 * Color-coded status badge with animated pulse dot for active processing states.
 * Safely falls back to pending style for unrecognized status values.
 */
export function StatusBadge({ status, failureType }: StatusBadgeProps) {
  const className = STATUS_CLASS[status] ?? 'badge-pending';
  return (
    <span className={`badge ${className}`}>
      <span className="badge-dot" aria-hidden="true" />
      <span>{status}</span>
      {status === 'FAILED' && failureType && (
        <span style={{ opacity: 0.85, fontSize: '0.6875rem' }}>
          ({failureType})
        </span>
      )}
    </span>
  );
}
