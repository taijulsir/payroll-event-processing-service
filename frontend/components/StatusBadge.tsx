const STATUS_CLASS: Record<string, string> = {
  PENDING: 'badge-pending',
  PROCESSING: 'badge-processing',
  SUCCEEDED: 'badge-succeeded',
  FAILED: 'badge-failed',
};

/** Color-coded status badge — the primary "make state changes obvious" affordance used on
 * both the list and detail pages. Falls back to the pending style for any unrecognized
 * status string rather than crashing (defensive against the backend evolving its status
 * set — the frontend never assumes it knows every possible value). */
export function StatusBadge({ status }: { status: string }) {
  const className = STATUS_CLASS[status] ?? 'badge-pending';
  return (
    <span className={`badge ${className}`}>
      <span className="badge-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
