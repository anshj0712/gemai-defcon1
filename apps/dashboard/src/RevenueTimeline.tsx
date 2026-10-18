import { useEffect, useState } from 'react';
import { DetectiveIcon, UserIcon } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchClusters, fetchRules, type ClusterSummary, type RuleView } from './api';
import { ago, money } from './format';
import { useRevenueSeries } from './lib/useRevenueSeries';
import { liveOrigin } from './lib/rules';

/**
 * What each rule did, rule by rule: who proposed it, when it went live, how many past shoppers its re-scan found, and
 * what its issue puts at risk now. This is the table view of the chart's rule markers.
 */
export function RuleImpact() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const { data } = useRevenueSeries();
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchRules(), fetchClusters()]).then(
      ([r, c]) => alive && (setRules(r.rules), setClusters(c.clusters)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!rules) return null;
  const withHistory = rules.filter((r) => r.active || (r.undone && r.undone.length > 0));
  if (withHistory.length === 0) return null;
  const findingFor = (ruleId: string) => {
    const c = clusters.find((x) => x.kind === 'invariant' && x.anchor === ruleId);
    return c ? (data?.findings.find((f) => f.cluster_id === c.cluster_id) ?? null) : null;
  };
  return (
    <Card className="gap-2 px-5">
      <h2 className="m-0 text-base font-semibold">By rule</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Proposed by</TableHead>
            <TableHead>Live since</TableHead>
            <TableHead className="text-right">Found in history</TableHead>
            <TableHead className="text-right">At risk on its issue now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {withHistory.map((r) => {
            const f = findingFor(r.rule_id);
            const origin = liveOrigin(r);
            return (
              <TableRow key={r.rule_id}>
                <TableCell className="font-medium whitespace-normal">
                  {r.title}
                  {!r.active && (
                    <Badge variant="secondary" className="ml-2">
                      switched off
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {origin === 'agent' ? (
                    <Badge className="gap-1 bg-agent-muted text-agent">
                      <DetectiveIcon data-icon="inline-start" aria-hidden="true" />
                      Agent
                    </Badge>
                  ) : (
                    <Badge className="gap-1 bg-info-muted text-info">
                      <UserIcon data-icon="inline-start" aria-hidden="true" />
                      You
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.active ? ago(r.active.approved_at) : '-'}</TableCell>
                <TableCell className="text-right font-semibold text-agent tabular-nums">{r.rescan ? r.rescan.sessions_hit : '-'}</TableCell>
                <TableCell className="text-right font-semibold text-money tabular-nums">
                  {f && f.revenue.status === 'ok' ? (
                    <a href={`#/issues/${f.cluster_id}`} className="text-money">
                      {money(f.revenue.revenue_at_risk_minor, f.revenue.currency)}
                    </a>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
