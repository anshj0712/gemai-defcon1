import type { DemoBugsView } from '../api';

/** Who catches each bug, in the words the switch panel uses. */
export const CAUGHT: Record<string, string> = {
  detector: 'Detector',
  builtin_rule: 'Built-in rule',
  merchant_rule: 'Your rule',
  agent_rule: 'Agent rule',
  agent: 'Agent finds it',
};

/** The switches grouped by churn reason, in the order the API lists the bugs. */
export function groupBugs(view: DemoBugsView): { reason: string; label: string; bugs: DemoBugsView['known'] }[] {
  const groups = new Map<string, DemoBugsView['known']>();
  for (const k of view.known) {
    const key = k.reason ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  return [...groups.entries()].map(([reason, bugs]) => ({ reason, label: view.reasons?.[reason] ?? 'Other', bugs }));
}
