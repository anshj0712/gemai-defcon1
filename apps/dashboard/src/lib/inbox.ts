import type { RuleView } from '../api';

/** Open agent proposals: the churn watcher's hypotheses and rule suggestions for issues, newest first. */
export function openProposals(rules: readonly RuleView[]): RuleView[] {
  return rules.filter((r) => r.draft?.origin === 'agent').sort((a, b) => b.draft!.created_at - a.draft!.created_at);
}

/** What a proposal's toast says: the hypothesis title and its gap, or the suggested rule's title. */
export function toastLine(r: RuleView): { title: string; detail: string } {
  const d = r.draft!;
  const w = d.watch;
  if (!w) return { title: d.rule.title, detail: 'A rule suggested for a recurring issue.' };
  return {
    title: w.title,
    detail: `${Math.round(w.segment.abandonment * 100)}% of ${w.segment.sessions} shoppers left, against ${Math.round(w.baseline.abandonment * 100)}% of the others (synthetic data).`,
  };
}

/** The bell's count as a full phrase, for its label and the screen-reader status. */
export const proposalsLabel = (n: number) => (n ? `${n} agent proposal${n > 1 ? 's' : ''} to review` : 'No open agent proposals');
