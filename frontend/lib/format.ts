const EVENT_TYPE_LABELS: Record<string, string> = {
  BANK_ACCOUNT_CHANGE: 'Bank Account Change',
  ADDRESS_CHANGE: 'Address Change',
  SALARY_CHANGE: 'Salary Change',
};

export function formatEventType(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}

export function formatSequence(seq: string | number): string {
  const num = Number(seq);
  if (Number.isNaN(num)) return `#${seq}`;
  return `#${num.toString().padStart(4, '0')}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return formatDateTime(iso);
}
