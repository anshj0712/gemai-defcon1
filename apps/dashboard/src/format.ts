import { FLAG_COLORS } from './markers';

/** Plain-language names for detectors, shown as symptom chips. */
export const SYMPTOMS: Record<string, string> = {
  dead_click: 'Dead clicks',
  rage_click: 'Rage clicks',
  response_decay: 'Stopped responding',
  invariant_check: 'Wrong totals',
  error_correlation: 'Errors',
};

export const symptomName = (detector: string) => SYMPTOMS[detector] ?? detector.replace(/_/g, ' ');
export const symptomColor = (detector: string) => FLAG_COLORS[detector] ?? '#6b7280';

/** "just now", "42 s ago", "5 min ago", "3 h ago", or a date. */
export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
