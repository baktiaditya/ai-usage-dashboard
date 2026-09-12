import { cn } from '@/lib/cn';

export interface ProgressProps {
  /** Remaining share of the window, 0..100. */
  readonly remainingPercent: number;
  readonly tone: 'healthy' | 'stale' | 'unavailable' | 'error';
  readonly label: string;
  readonly className?: string;
}

const FILL: Record<ProgressProps['tone'], string> = {
  healthy: 'bg-healthy',
  stale: 'bg-stale',
  unavailable: 'bg-unavailable',
  error: 'bg-danger',
};

/**
 * The bar shows quota *remaining*, because that is the question a user is
 * asking. The underlying `usedPercent` is what the provider reported and is
 * preserved verbatim in storage and in the diagnostics panel.
 */
export function Progress({ remainingPercent, tone, label, className }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, remainingPercent));
  return (
    <div
      className={cn('bg-surface-muted h-2 w-full overflow-hidden rounded-full', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', FILL[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
