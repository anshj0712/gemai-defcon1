import { useState, type ReactNode } from 'react';
import type { Claim, Cluster, EvidenceItem, Finding } from '@cp/schema';
import { CaretDownIcon, CaretUpIcon, InfoIcon, PlayIcon, ScalesIcon } from '@phosphor-icons/react';
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
  confirmed: { label: 'Visually confirmed', className: 'bg-success-muted text-success' },
  not_confirmed: { label: 'Not visible on screen', className: 'bg-tier-p0/12 text-tier-p0-ink' },
  unclear: { label: 'Unclear on screen', className: 'bg-tier-p2/14 text-tier-p2-ink' },
  not_checked: { label: 'Not visually checked', className: 'bg-tier-p3/14 text-tier-p3-ink' },
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

/** A titled block inside a tab. */
function Block({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

export const latestReplayHref = (cluster: Cluster) => {
  const latest = cluster.evidence[0];
  return latest ? `#/sessions/${latest.session_id}?signal=${latest.signal_id}` : null;
};

/** The issue's title block: always visible above the tabs. */
export function FindingHeader({ finding: f, cluster }: { finding: Finding; cluster: Cluster }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <TierBadge tier={f.tier} />
        {f.triage && <Badge variant="outline">{CATEGORY_NAMES[f.triage.category] ?? f.triage.category}</Badge>}
        {f.status === 'suspect' && <NeedsReviewBadge title={f.verdict?.outcome === 'rejected' ? f.verdict.summary : 'The visual check did not show the defect on screen. A person should look before acting.'} />}
        {cluster.found_later && cluster.found_later.sessions > 0 && (
          <FoundLaterBadge href="#/history" title="Open time travel: what we knew before the rule, against what we know now">
            Found later · {cluster.found_later.sessions} of {cluster.session_count} sessions
          </FoundLaterBadge>
        )}
      </div>
      <h1 className="issue-title m-0 font-display text-[30px] leading-[1.12] font-medium tracking-[-0.02em]">{f.title}</h1>
      <p className="m-0 text-[13px] text-muted-foreground">
        On {cluster.route} · {cluster.session_count} shoppers · first seen {time(cluster.first_seen)}
      </p>
    </div>
  );
}

const OUTCOME = {
  approved: { label: 'Approved', className: 'bg-success-muted text-success' },
  rejected: { label: 'Held back', className: 'bg-danger-muted text-money' },
  unavailable: { label: 'Not reviewed', className: 'bg-muted text-muted-foreground' },
} as const;

/** "Reviewed by 4 AI jurors: Approved, 99%": the jury in one line, with a way to the full review. */
function JuryLine({ v, onOpen }: { v: NonNullable<Finding['verdict']>; onOpen: () => void }) {
  const outcome = OUTCOME[v.outcome as keyof typeof OUTCOME] ?? OUTCOME.unavailable;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <ScalesIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <span>
        Reviewed by {v.jurors_asked} AI jurors:
      </span>
      <Badge className={outcome.className}>{outcome.label}</Badge>
      {v.mean_score !== null && <span className="font-semibold tabular-nums">{Math.round(v.mean_score * 100)}%</span>}
      <Button variant="link" size="xs" className="ml-auto" onClick={onOpen}>
        See the review
      </Button>
    </div>
  );
}

/** Summary tab: what it costs, what happened, why, and how to see it yourself. */
export function FindingSummaryTab({ finding: f, onOpenReview }: { finding: Finding; onOpenReview: () => void }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const offline = f.model_version.split('+').includes(OFFLINE_MODEL);
  const steps = f.triage?.repro_steps ?? [];
  const affected = Number.isInteger(r.affected_with_cart) ? r.affected_with_cart : Number(r.affected_with_cart.toFixed(1));
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card size="sm" className={cn('gap-0.5 px-4', r.status === 'ok' ? 'bg-danger-muted ring-danger-border' : 'bg-muted')} title={r.status === 'ok' ? formulaLine(r) : undefined}>
          <span className="text-[13px] text-muted-foreground">Revenue lost so far</span>
          {r.status === 'ok' ? (
            <span className="text-3xl leading-tight font-semibold tracking-[-0.02em] text-money">
              <AnimatedNumber value={r.revenue_at_risk_minor} format={(n) => money(Math.round(n), r.currency)} ms={900} />
            </span>
          ) : (
            <span className="text-xl font-semibold text-muted-foreground">Estimating…</span>
          )}
        </Card>
        <Card size="sm" className="gap-0.5 px-4">
          <span className="text-[13px] text-muted-foreground">Shoppers with a cart who hit it</span>
          <span className="text-3xl leading-tight font-semibold tracking-[-0.02em]">
            <AnimatedNumber value={affected} />
          </span>
        </Card>
        <Card size="sm" className="gap-0.5 px-4">
          <span className="text-[13px] text-muted-foreground">Left without ordering</span>
          <span className="text-3xl leading-tight font-semibold tracking-[-0.02em] tabular-nums">
            {pct(r.abandonment_affected)} <span className="text-base font-normal text-muted-foreground">vs {pct(r.abandonment_baseline)} normally</span>
          </span>
        </Card>
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

      {f.triage ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Block title="What happened">
              <ClaimText claim={f.triage.summary} byId={byId} />
            </Block>
            <Block title="Likely cause">
              <ClaimText claim={f.triage.likely_cause} byId={byId} />
            </Block>
            {f.root_cause && (
              <Block title="Where to look first">
                <p className="m-0">
                  <b className="font-semibold">{f.root_cause.suggested_fix_area}</b>
                </p>
              </Block>
            )}
          </div>
          <Block title="How to reproduce">
            {steps.length > 0 ? (
              <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5">
                {steps.map((s, i) => (
                  <li key={i}>
                    {plain(s.step)} <EvidenceChips ids={s.evidence_ids} byId={byId} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-muted-foreground">No steps yet.</p>
            )}
          </Block>
        </div>
      ) : (
        <p className="m-0 text-muted-foreground">No agent analysis yet.</p>
      )}

      {f.verdict && <JuryLine v={f.verdict} onOpen={onOpenReview} />}
    </div>
  );
}

/** Proof tab: the screenshot the visual check used, what it saw, and the latest occurrences to watch. */
export function FindingProofTab({ finding: f, cluster }: { finding: Finding; cluster: Cluster }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const verdict = VERDICTS[f.root_cause?.visual_check ?? 'not_checked'] ?? VERDICTS.not_checked!;
  const replayHref = latestReplayHref(cluster);
  const shotHref = f.screenshot ? (evidenceHref(byId.get(f.screenshot.evidence_id)) ?? `#/sessions/${f.screenshot.session_id}?signal=${f.screenshot.signal_id}`) : replayHref;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="m-0 text-sm font-semibold">The flagged moment</h3>
          <Badge className={verdict.className}>{verdict.label}</Badge>
        </div>
        {f.screenshot && shotHref ? (
          <a href={shotHref} title="Open the replay at this moment">
            <img className="w-full rounded-lg border" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt="The flagged moment, rendered from the masked replay, with the element outlined in red" />
          </a>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">No screenshot (the visual check is off, or no replay could be rendered).</p>
        )}
        {f.root_cause && (
          <Block title="What the visual check saw">
            <ClaimText claim={f.root_cause.visual_notes} byId={byId} />
          </Block>
        )}
        {f.root_cause && (
          <Block title="Root-cause hypothesis">
            <ClaimText claim={f.root_cause.hypothesis} byId={byId} />
          </Block>
        )}
        <p className="m-0 text-xs text-muted-foreground">Rendered from the stored, masked replay: inputs and personal text never reach the model.</p>
      </div>
      <Block title="Latest occurrences">
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
      </Block>
    </div>
  );
}

const JUROR_NAMES: Record<string, { name: string; asks: string }> = {
  evidence_auditor: { name: 'Fact checker', asks: 'Does every claim rest on the evidence it cites?' },
  skeptic: { name: 'False-alarm hunter', asks: 'Could this just be normal shopper behaviour?' },
  impact_analyst: { name: 'Money and priority', asks: 'Do the numbers and the priority fit the evidence?' },
  repro_reviewer: { name: 'Steps check', asks: 'Could an engineer reproduce and fix it from this?' },
};

/** The jury's verdict: four independent scores, the bar they had to clear, and the judge's ruling in words. */
function VerdictCard({ v, byId, defaultOpen = false }: { v: NonNullable<Finding['verdict']>; byId: Map<string, EvidenceItem>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bar = Math.round(v.threshold * 100);
  const outcome = OUTCOME[v.outcome as keyof typeof OUTCOME] ?? OUTCOME.unavailable;
  return (
    <Card size="sm" className={cn('gap-2 px-4', v.outcome === 'rejected' && 'bg-danger-muted ring-danger-border', v.outcome === 'unavailable' && 'ring-0 outline-1 outline-border outline-dashed')}>
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ScalesIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Eyebrow>Jury verdict</Eyebrow>
        <Badge className={outcome.className}>{outcome.label}</Badge>
        {v.mean_score !== null && (
          <span className="ml-auto text-sm font-semibold tabular-nums">
            {Math.round(v.mean_score * 100)}% <span className="text-xs font-normal text-muted-foreground">· the bar is above {bar}%</span>
          </span>
        )}
        {open ? <CaretUpIcon aria-hidden="true" className="size-4 text-muted-foreground" /> : <CaretDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
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

/** Technical tab: the jury's full review, how the issue was scored, the evidence the agents saw, and the audit trail. */
export function FindingTechnicalTab({ finding: f, versions }: { finding: Finding; versions: FindingVersionView[] }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const p = f.priority;
  const failed = f.runs.filter((x) => !x.ok);

  return (
    <div className="flex flex-col gap-2">
      {f.verdict && <VerdictCard v={f.verdict} byId={byId} defaultOpen />}
      <Fold title="How it was scored" hint={`${p.base_tier} · score ${f.score.toLocaleString('en-IN')}`} defaultOpen>
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
          Score {f.score.toLocaleString('en-IN')} = revenue at risk × tier weight{p.regression ? ' × regression multiplier' : ''}. The ranker may move a finding one tier at most, only with a cited rule.
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
                  <TableCell className="w-28 align-top font-mono text-xs text-muted-foreground">{e.kind}</TableCell>
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
    </div>
  );
}
