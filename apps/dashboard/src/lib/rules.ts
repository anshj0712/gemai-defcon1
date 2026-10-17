import type { RuleView } from '../api';

/** Who a live rule came from. Rules approved before origin was recorded fall back to the approval feedback. */
export function liveOrigin(r: RuleView): 'agent' | 'human' {
  if (r.active?.origin) return r.active.origin;
  const approved = [...(r.feedback ?? [])].reverse().find((f) => f.verdict === 'approved');
  return approved?.feature_key ? 'agent' : 'human';
}
