import type { Signal, SignalRow } from '@cp/schema';
import { normalizeSelector, routeTemplate, shortHash } from './fingerprint.js';
import type { DetectorRun } from './index.js';

/**
 * Detector output -> signal rows, shared by the live processor and the retroactive re-scan so that
 * both give the same hit the same `signal_id`. That id is the warehouse insertId and the clusterer's
 * applied marker, so overlap between live processing and a re-scan (or a re-run of one) dedupes.
 */

type RunInfo = Pick<DetectorRun, 'detector' | 'ruleVersion'>;

/** The rule version a signal was produced under: its own (invariant rules) or the run's params hash. */
export const signalRuleVersion = (run: RunInfo, s: Signal) => s.ruleVersion ?? run.ruleVersion;

/** Identity of a detector hit, independent of which delivery, chunk, or re-scan decided it. */
export function signalId(tenantId: string, run: RunInfo, s: Signal): string {
  const e = s.evidence;
  return shortHash([tenantId, e.sessionId, s.detector, run.detector.version, signalRuleVersion(run, s), e.seq, e.tStart, e.selector ?? ''].join('|'), 32);
}

export interface SignalRowContext {
  tenantId: string;
  sessionId: string;
  /** The chunk's page route, used when a signal names none. */
  pageRoute: string;
  release: string;
  /** Transaction time: when this pass learned of the hit. */
  ingestTime: number;
  /** Set when a retroactive re-scan writes the rows. */
  rescanId?: string;
}

export function toSignalRows(runs: readonly Pick<DetectorRun, 'detector' | 'ruleVersion' | 'signals'>[], ctx: SignalRowContext): SignalRow[] {
  return runs.flatMap((run) =>
    run.signals.map(
      (s): SignalRow => ({
        signal_id: signalId(ctx.tenantId, run, s),
        tenant_id: ctx.tenantId,
        session_id: ctx.sessionId,
        seq: s.evidence.seq,
        detector: s.detector,
        detector_version: run.detector.version,
        rule_version: signalRuleVersion(run, s),
        fingerprint: s.fingerprint,
        route: routeTemplate(s.evidence.route ?? ctx.pageRoute),
        element_selector: s.evidence.selector ? normalizeSelector(s.evidence.selector) : null,
        release: ctx.release,
        evidence: { ...s.evidence },
        // Valid time stays the browser's (skew-corrected) time, whenever the hit is learned.
        event_time: s.eventTime,
        ingest_time: ctx.ingestTime,
        ...(ctx.rescanId ? { rescan_id: ctx.rescanId } : {}),
      }),
    ),
  );
}
