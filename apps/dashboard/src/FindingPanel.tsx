import { useState, type ReactNode } from 'react';
import type { Claim, Cluster, EvidenceItem, Finding } from '@cp/schema';
import { ChevronDownIcon, ChevronUpIcon, InfoIcon, PlayIcon, ScaleIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { screenshotUrl, type FindingVersionView } from './api';
import { AnimatedNumber, Eyebrow, Fold, FoundLaterBadge, NeedsReviewBadge, TierBadge } from './components/common';
import { CATEGORY_NAMES, formulaLine, money, pct, plain, time } from './format';


const OFFLINE_MODEL = 'offline-stand-in';

/** The visual check's result, in words and a status tone (never color alone). */
const VERDICTS: Record<string, { label: string; className: string }> = {
  confirmed: { label: 'Visually confirmed', className: 'bg-success-solid text-tier-foreground' },
  not_confirmed: { label: 'Not visible on screen', className: 'bg-tier-p0 text-tier-foreground' },
  unclear: { label: 'Unclear on screen', className: 'bg-tier-p2 text-tier-foreground' },
  not_checked: { label: 'Not visually checked', className: 'bg-tier-p3 text-tier-foreground' },
};

/** Where an evidence item leads: signals and the screenshot open the replay at their moment. */
function evidenceHref(e: EvidenceItem | undefined): string | null {
  return e?.session_id ? `#/sessions/${e.session_id}${e.signal_id ? `?signal=${e.signal_id}` : ''}` : null;
}

const chipClass = 'inline-flex items-center gap-0.5 rounded-md px-1.5 py-px font-mono text-[11px] font-medium no-underline';

function EvidenceChips({ ids, byId }: { ids: readonly string[]; byId: Map<string, EvidenceItem> }) {
  if (ids.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const e = byId.get(id);
        const href = evidenceHref(e);
        const title = e ? e.text : 'unknown evidence';
        return href ? (
          <a key={id} className={cn(chipClass, 'bg-info-muted text-info hover:underline')} href={href} title={`${title} (opens the replay)`}>
            {id}
            <PlayIcon aria-hidden="true" className="size-2.5" />
          </a>
        ) : (
          <span key={id} className={cn(chipClass, 'bg-muted text-muted-foreground')} title={title}>
            {id}
          </span>
        );
      })}
    </span>
  );
}

function ClaimText({ claim, byId, className }: { claim: Claim; byId: Map<string, EvidenceItem>; className?: string }) {
  return (
    <p className={cn('m-0 leading-relaxed', className)}>
      {plain(claim.text)} <EvidenceChips ids={claim.evidence_ids} byId={byId} />
    </p>
  );
}

const watchLink = (href: string, label = 'Watch replay', size: 'xs' | 'sm' = 'xs') => (
  <a className={cn(buttonVariants({ variant: 'outline', size }), 'no-underline')} href={href}>
    <PlayIcon data-icon="inline-start" aria-hidden="true" />
    {label}
  </a>
);

/** A summary card: the gist at a glance, the full detail one click away. An open card takes the whole row. */
function SummaryCard({ title, badge, open, onToggle, summary, detail }: { title: string; badge?: ReactNode; open: boolean; onToggle: () => void; summary: ReactNode; detail: ReactNode }) {
  return (
    <Card size="sm" className={cn('gap-2 px-4', open && 'ring-info-border md:col-span-3')}>
      <div className="flex items-center gap-2">
        <Eyebrow>{title}</Eyebrow>
        {badge}
        <Button variant="ghost" size="xs" className="ml-auto text-primary" onClick={onToggle} aria-expanded={open}>
          {open ? 'Less' : 'Details'}
          {open ? <ChevronUpIcon data-icon="inline-end" aria-hidden="true" /> : <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />}
        </Button>
      </div>
      <div key={open ? 'detail' : 'summary'} className="motion-reveal flex flex-col gap-2 text-sm">{open ? detail : summary}</div>
    </Card>
  );
}

const DetailHeading = ({ children }: { children: ReactNode }) => <h4 className="m-0 mt-2 text-[13px] font-semibold text-foreground first:mt-0">{children}</h4>;

const JUROR_NAMES: Record<string, { name: string; asks: string }> = {
  evidence_auditor: { name: 'Fact checker', asks: 'Does every claim rest on the evidence it cites?' },
  skeptic: { name: 'False-alarm hunter', asks: 'Could this just be normal shopper behaviour?' },
  impact_analyst: { name: 'Money and priority', asks: 'Do the numbers and the priority fit the evidence?' },
  repro_reviewer: { name: 'Steps check', asks: 'Could an engineer reproduce and fix it from this?' },
};

const OUTCOME = {
  approved: { label: 'Approved', className: 'bg-success-muted text-success' },
  rejected: { label: 'Held back', className: 'bg-danger-muted text-money' },
  unavailable: { label: 'Not reviewed', className: 'bg-muted text-muted-foreground' },
} as const;

/** The jury's verdict: four independent scores, the bar they had to clear, and the judge's ruling in words. */
function VerdictCard({ v, byId }: { v: NonNullable<Finding['verdict']>; byId: Map<string, EvidenceItem> }) {
  const [open, setOpen] = useState(false);
  const bar = Math.round(v.threshold * 100);
  const outcome = OUTCOME[v.outcome as keyof typeof OUTCOME] ?? OUTCOME.unavailable;
  return (
    <Card size="sm" className={cn('mt-3 gap-2 px-4', v.outcome === 'rejected' && 'bg-danger-muted ring-danger-border', v.outcome === 'unavailable' && 'ring-0 outline-1 outline-border outline-dashed')}>
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ScaleIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Eyebrow>Jury verdict</Eyebrow>
        <Badge className={outcome.className}>{outcome.label}</Badge>
        {v.mean_score !== null && (
          <span className="ml-auto text-sm font-semibold tabular-nums">
            {Math.round(v.mean_score * 100)}% <span className="text-xs font-normal text-muted-foreground">· the bar is above {bar}%</span>
          </span>
        )}
        {open ? <ChevronUpIcon aria-hidden="true" className="size-4 text-muted-foreground" /> : <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
      </button>
      <div className="text-sm">{v.ruling ? <ClaimText claim={v.ruling} byId={byId} /> : <p className="m-0">{v.summary}</p>}</div>
      {v.ruling && <p className="m-0 text-xs text-muted-foreground">{v.summary}</p>}
      {open && (
        <div className="motion-reveal mt-1 grid gap-3 md:grid-cols-2">
          {v.jurors.map((j) => {
            const n = JUROR_NAMES[j.role] ?? { name: j.role, asks: '' };
            const pctScore = j.score === null ? 0 : Math.round(j.score * 100);
            const pass = pctScore / 100 > v.threshold;
            return (
              <div key={j.role} className="flex flex-col gap-1.5 rounded-lg border p-3">
                <div className="flex items-baseline gap-2">
                  <b className="font-semibold">{n.name}</b>
                  <span className="ml-auto text-sm font-semibold tabular-nums">{j.score === null ? 'did not answer' : `${pctScore}%`}</span>
                </div>
                <span className="text-xs text-muted-foreground">{n.asks}</span>
                <div className="relative h-2 rounded-full bg-muted" title={`The bar is ${bar}%`}>
                  <span className={cn('motion-grow block h-full rounded-full', pass ? 'bg-success-strong' : 'bg-warn-strong')} style={{ width: `${pctScore}%` }} />
                  <i aria-hidden="true" className="absolute -top-1 -bottom-1 w-0.5 bg-foreground" style={{ left: `${bar}%` }} />
                </div>
                {j.rationale && <ClaimText claim={j.rationale} byId={byId} className="text-[13px]" />}
              </div>
            );
          })}
          <p className="m-0 text-xs text-muted-foreground md:col-span-2">
            {v.jurors_answered} of {v.jurors_asked} jurors answered. Code takes the decision from their average and two checks (the AI steps passed their own checks; the screenshot did not contradict the report); the judge only writes the words.
            {v.offline ? ' Scored by the offline stand-in, not Gemini.' : ''}
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * The top of an issue page: what it costs, what happened, the proof, and how to see it yourself. Each
 * piece is a compact card that opens for the full story (claims linked to their evidence).
 */
export function FindingSummary({ finding: f, cluster }: { finding: Finding; cluster: Cluster }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const offline = f.model_version.split('+').includes(OFFLINE_MODEL);
  const verdict = VERDICTS[f.root_cause?.visual_check ?? 'not_checked'] ?? VERDICTS.not_checked!;
  const latest = cluster.evidence[0];
  const replayHref = latest ? `#/sessions/${latest.session_id}?signal=${latest.signal_id}` : null;
  const steps = f.triage?.repro_steps ?? [];
  const shotHref = f.screenshot ? (evidenceHref(byId.get(f.screenshot.evidence_id)) ?? `#/sessions/${f.screenshot.session_id}?signal=${f.screenshot.signal_id}`) : replayHref;
  const shotAlt = 'The flagged moment, rendered from the masked replay, with the element outlined in red';

  return (
    <section className="flex flex-col gap-3">
      <div className="grid gap-4 md:grid-cols-[minmax(280px,340px)_1fr]">
        <Card className={cn('justify-center gap-1 px-5', r.status === 'ok' ? 'bg-danger-muted ring-danger-border' : 'bg-muted')} title={r.status === 'ok' ? formulaLine(r) : undefined}>
          <Eyebrow className={r.status === 'ok' ? 'text-money' : undefined}>Estimated revenue lost</Eyebrow>
          {r.status === 'ok' ? (
            <>
              <div className="text-4xl leading-tight font-bold text-money tabular-nums">
                <AnimatedNumber value={r.revenue_at_risk_minor} format={(n) => money(Math.round(n), r.currency)} ms={900} />
              </div>
              <p className="m-0 text-[13px] text-foreground/80">
                {Number.isInteger(r.affected_with_cart) ? r.affected_with_cart : r.affected_with_cart.toFixed(1)} shoppers with a cart hit this. {pct(r.abandonment_affected)} left, against {pct(r.abandonment_baseline)} normally.
              </p>
            </>
          ) : (
            <>
              <div className="text-2xl font-semibold text-muted-foreground">Estimating…</div>
              <p className="m-0 text-[13px] text-muted-foreground">{r.note}</p>
            </>
          )}
        </Card>

        <div className="flex min-w-0 flex-col items-start justify-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierBadge tier={f.tier} />
            {f.triage && <Badge variant="outline">{CATEGORY_NAMES[f.triage.category] ?? f.triage.category}</Badge>}
            {f.status === 'suspect' && <NeedsReviewBadge title={f.verdict?.outcome === 'rejected' ? f.verdict.summary : 'The visual check did not show the defect on screen. A person should look before acting.'} />}
            {cluster.found_later && cluster.found_later.sessions > 0 && (
              <FoundLaterBadge href="#/history" title="Open time travel: what we knew before the rule, against what we know now">
                Found later · {cluster.found_later.sessions} of {cluster.session_count} sessions surfaced by re-scanning history
              </FoundLaterBadge>
            )}
          </div>
          <h1 className="issue-title m-0 text-2xl leading-tight font-semibold tracking-tight">{f.title}</h1>
          <p className="m-0 text-[13px] text-muted-foreground">
            <code>{cluster.anchor}</code> on {cluster.route} · {cluster.session_count} sessions · {cluster.signal_count} signals · first seen {time(cluster.first_seen)}
          </p>
          {replayHref && (
            <a className={cn(buttonVariants({ size: 'lg' }), 'mt-1 no-underline')} href={replayHref}>
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
              Watch the latest occurrence
            </a>
          )}
        </div>
      </div>

      {offline && (
        <Alert className="border-synthetic-border bg-synthetic-muted text-synthetic">
          <InfoIcon aria-hidden="true" />
          <AlertTitle>Offline stand-in: templated text</AlertTitle>
          <AlertDescription className="text-synthetic">
            <span>
              This analysis is templated from the evidence, not written by Gemini, and the screenshot was not checked. Set <code>GOOGLE_API_KEY</code> and restart <code>pnpm dev</code> for Gemini.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-3 md:grid-cols-3">
        <SummaryCard
          title="What shoppers hit"
          open={!!open.issue}
          onToggle={() => toggle('issue')}
          summary={
            f.triage ? (
              <>
                <p className="m-0 line-clamp-4">{plain(f.triage.summary.text)}</p>
                <Eyebrow className="mt-1">Likely cause</Eyebrow>
                <p className="m-0 line-clamp-2 text-[13px] text-muted-foreground">{plain(f.triage.likely_cause.text)}</p>
              </>
            ) : (
              <p className="m-0 text-muted-foreground">No agent analysis yet.</p>
            )
          }
          detail={
            f.triage && (
              <>
                <DetailHeading>What happened</DetailHeading>
                <ClaimText claim={f.triage.summary} byId={byId} />
                <DetailHeading>Likely cause</DetailHeading>
                <ClaimText claim={f.triage.likely_cause} byId={byId} />
                {f.root_cause && (
                  <>
                    <DetailHeading>Root-cause hypothesis</DetailHeading>
                    <ClaimText claim={f.root_cause.hypothesis} byId={byId} />
                    <p className="m-0 text-[13px]">
                      Look first at: <b className="font-semibold">{f.root_cause.suggested_fix_area}</b>
                    </p>
                  </>
                )}
              </>
            )
          }
        />

        <SummaryCard
          title="Proof"
          badge={<Badge className={verdict.className}>{verdict.label}</Badge>}
          open={!!open.proof}
          onToggle={() => toggle('proof')}
          summary={
            <>
              {f.screenshot && shotHref ? (
                <a href={shotHref} title="Open the replay at this moment">
                  <img className="max-h-[150px] w-full rounded-md border object-cover object-top" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt={shotAlt} />
                </a>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">No screenshot (the visual check is off, or no replay could be rendered).</p>
              )}
              {replayHref && <div>{watchLink(replayHref, 'Watch replay', 'sm')}</div>}
            </>
          }
          detail={
            <>
              {f.screenshot && shotHref && (
                <a href={shotHref} title="Open the replay at this moment">
                  <img className="w-full max-w-[560px] rounded-md border" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt={shotAlt} />
                </a>
              )}
              {f.root_cause && (
                <>
                  <DetailHeading>What the visual check saw</DetailHeading>
                  <ClaimText claim={f.root_cause.visual_notes} byId={byId} />
                </>
              )}
              <DetailHeading>Latest occurrences</DetailHeading>
              <Table>
                <TableBody>
                  {cluster.evidence.map((e) => (
                    <TableRow key={e.signal_id}>
                      <TableCell className="tabular-nums">{time(e.event_time)}</TableCell>
                      <TableCell>
                        <code>{e.session_id.slice(0, 14)}…</code>
                      </TableCell>
                      <TableCell className="text-right">{watchLink(`#/sessions/${e.session_id}?signal=${e.signal_id}`)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="m-0 text-xs text-muted-foreground">Rendered from the stored, masked replay: inputs and personal text never reach the model.</p>
            </>
          }
        />

        <SummaryCard
          title="How to recreate"
          open={!!open.steps}
          onToggle={() => toggle('steps')}
          summary={
            steps.length > 0 ? (
              <>
                <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">
                  {steps.slice(0, 3).map((s, i) => (
                    <li key={i}>
                      <span className="line-clamp-2">{plain(s.step)}</span>
                    </li>
                  ))}
                </ol>
                {steps.length > 3 && (
                  <p className="m-0 text-xs text-muted-foreground">
                    + {steps.length - 3} more step{steps.length - 3 === 1 ? '' : 's'}
                  </p>
                )}
              </>
            ) : (
              <p className="m-0 text-muted-foreground">No steps yet.</p>
            )
          }
          detail={
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5">
              {steps.map((s, i) => (
                <li key={i}>
                  {plain(s.step)} <EvidenceChips ids={s.evidence_ids} byId={byId} />
                </li>
              ))}
            </ol>
          }
        />
      </div>
      {f.verdict && <VerdictCard v={f.verdict} byId={byId} />}
    </section>
  );
}

/** Everything behind the summary, closed by default: scoring, evidence, symptoms, sessions, audit trail. */
export function FindingFolds({ finding: f, versions }: { finding: Finding; versions: FindingVersionView[] }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const p = f.priority;
  const failed = f.runs.filter((x) => !x.ok);

  return (
    <>
      <Fold title="How it was scored" hint={`${p.base_tier} · score ${f.score.toLocaleString('en-IN')}`}>
        {r.status === 'ok' ? (
          <>
            <p className="m-0 rounded-md border bg-muted px-3 py-2 font-mono text-[12.5px]">{formulaLine(r)}</p>
            <p className="m-0 text-xs text-muted-foreground">
              Affected sessions with a cart × average cart × (abandonment of affected sessions − abandonment of the {r.baseline_scope === 'route' ? `baseline on ${f.route}` : 'baseline on all routes'}). {r.affected_abandoned} of{' '}
              {r.affected_decided} affected abandoned; {r.baseline_abandoned} of {r.baseline_decided} baseline.
              {r.pending > 0 ? ` ${r.pending} affected still shopping.` : ''} {r.note ?? ''}
            </p>
          </>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">{r.note}</p>
        )}
        <p className="m-0 text-[13px]">
          Base tier <b>{p.base_tier}</b> from{' '}
          {p.base_rule_ids.length
            ? p.base_rule_ids.map((id, i) => (
                <span key={id}>
                  {i ? ', ' : ''}
                  <code>{id}</code>
                </span>
              ))
            : 'no rule'}
          {p.tier_move !== 0 ? (
            <>
              , moved {p.tier_move < 0 ? 'up' : 'down'} one tier to <b>{f.tier}</b> by the ranker citing <code>{p.move_rule_id}</code>
            </>
          ) : (
            <>, unchanged by the ranker</>
          )}
          {p.regression ? `, × ${p.multiplier} as a regression after a release` : ''}.
        </p>
        {f.ranker && <ClaimText claim={f.ranker.reason} byId={byId} className="text-[13px]" />}
        <p className="m-0 text-xs text-muted-foreground">
          Score {f.score.toLocaleString('en-IN')} = revenue at risk × tier weight{p.regression ? ' × regression multiplier' : ''}. The ranker may move a finding one tier at most, only with a cited rule. Abandonment rates in the demo are set by
          the simulator.
        </p>
      </Fold>

      <Fold title="Evidence the agents saw" hint={`${f.evidence.length} items`}>
        <p className="m-0 text-xs text-muted-foreground">As supplied at analysis time ({time(f.runs[0]?.at ?? f.updated_at)}); the analysis re-runs when the issue changes or its sessions double.</p>
        <Table>
          <TableBody>
            {f.evidence.map((e) => {
              const href = evidenceHref(e);
              return (
                <TableRow key={e.id}>
                  <TableCell className="w-12 align-top">
                    <span className={cn(chipClass, 'bg-muted text-muted-foreground')}>{e.id}</span>
                  </TableCell>
                  <TableCell className="w-28 align-top text-xs text-muted-foreground uppercase">{e.kind}</TableCell>
                  <TableCell className="text-[13px] whitespace-normal">{e.text}</TableCell>
                  <TableCell className="w-32 text-right align-top">{href && watchLink(href)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Fold>

      <Fold title="Audit trail" hint={`${f.runs.length} agent runs · ${versions.length} versions${failed.length ? ` · ${failed.length} rejected` : ''}`}>
        <Table>
          <TableBody>
            {f.runs.map((x) => (
              <TableRow key={x.agent}>
                <TableCell className="w-32 text-muted-foreground capitalize">{x.agent.replace('_', ' ')}</TableCell>
                <TableCell className="text-[13px] whitespace-normal">
                  <code>{x.model}</code> · prompt <code>{x.prompt_hash}</code> · {x.attempts} attempt{x.attempts === 1 ? '' : 's'} · {x.ok ? 'accepted' : <b className="text-money">rejected: {x.error}</b>}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="text-muted-foreground">Rule set</TableCell>
              <TableCell>
                <code>{f.rule_version.split(':')[0]}</code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <h4 className="m-0 text-[13px] font-semibold">Versions</h4>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Recorded</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">At risk</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions
              .slice(-8)
              .reverse()
              .map((v) => (
                <TableRow key={`${v.recorded_from}-${v.version}`}>
                  <TableCell>v{v.version ?? '?'}</TableCell>
                  <TableCell className="tabular-nums">
                    {time(v.recorded_from)} → {v.recorded_to ? time(v.recorded_to) : 'current'}
                  </TableCell>
                  <TableCell>
                    <TierBadge tier={v.tier} short />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(v.revenue_at_risk_minor, v.currency || null)}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.affected_sessions}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        <p className="m-0 text-xs text-muted-foreground">Each change writes a new version row; earlier versions are never overwritten.</p>
      </Fold>
    </>
  );
}
