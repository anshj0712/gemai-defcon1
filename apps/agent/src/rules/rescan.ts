import type { Logger } from '@cp/logger';
import type { BlobStore, Publisher, Warehouse, WarehouseReader } from '@cp/platform';
import { ruleVersionOf, type InvariantRule, type RecordedProbeSpec, type RescanStatus } from '@cp/schema';
import { checkSession } from './evaluate.js';
import { scanWindow } from './scan.js';

/**
 * Retroactive re-scan, fast path (ARCHITECTURE.md section 6; skill bitemporal-rescan). Replays a
 * window of raw chunks through the real invariant detector with one approved rule and writes what it
 * finds as new signals: the original `event_time` (valid time), `ingest_time` = now (transaction time),
 * the rule's version, and the re-scan id. Signals go to the warehouse and to the `signals` topic, so
 * the clusterer and the agent pipeline treat them like live ones, and the clusterer counts the sessions
 * they add as found later.
 *
 * Idempotent (rule 5): a signal's id does not depend on when or how it was found, so a re-run, or an
 * overlap with live detection, writes and clusters nothing twice. Nothing is updated in place (rule 4).
 */

export interface RescanDeps {
  reader: WarehouseReader;
  blob: BlobStore;
  warehouse: Warehouse;
  publisher: Publisher;
  signalsTopic: string;
  logger: Logger;
  now?: () => number;
}

export interface RescanRequest {
  tenantId: string;
  rule: InvariantRule;
  rescanId: string;
  window: { from: number; to: number };
  maxSessions: number;
  concurrency: number;
  /** The tenant's recorded probes, read from each session as it is re-scanned (the rule may use them). */
  recordedProbes?: readonly RecordedProbeSpec[];
  /** Called with the running totals, at most every `progressMs`, and once at the end. */
  onProgress?: (status: RescanStatus) => Promise<void> | void;
  progressMs?: number;
}

export function initialStatus(req: Pick<RescanRequest, 'rescanId' | 'rule' | 'window'>, startedAt: number): RescanStatus {
  return {
    rescan_id: req.rescanId,
    rule_version: ruleVersionOf(req.rule),
    status: 'running',
    window: req.window,
    started_at: startedAt,
    finished_at: null,
    sessions_total: 0,
    sessions_scanned: 0,
    sessions_failed: 0,
    chunks_scanned: 0,
    sessions_hit: 0,
    signals_written: 0,
    truncated: false,
    error: null,
  };
}

export async function runRescan(deps: RescanDeps, req: RescanRequest): Promise<RescanStatus> {
  const now = deps.now ?? Date.now;
  const log = deps.logger.child({ tenant_id: req.tenantId, rescan_id: req.rescanId, rule_version: ruleVersionOf(req.rule) });
  const status = initialStatus(req, now());
  let lastProgress = 0;
  const progress = async (force = false) => {
    if (!req.onProgress) return;
    if (!force && now() - lastProgress < (req.progressMs ?? 2000)) return;
    lastProgress = now();
    await req.onProgress({ ...status });
  };
  log.info({ window_from: req.window.from, window_to: req.window.to, max_sessions: req.maxSessions }, 're-scan started');

  try {
    const summary = await scanWindow(deps, {
      tenantId: req.tenantId,
      fromMs: req.window.from,
      toMs: req.window.to,
      maxSessions: req.maxSessions,
      concurrency: req.concurrency,
      ...(req.recordedProbes?.length ? { recordedProbes: req.recordedProbes } : {}),
      onListed: async (sessions, truncated) => {
        status.sessions_total = sessions;
        status.truncated = truncated;
        await progress(true);
      },
      onSession: async (session) => {
        const { signals } = checkSession(req.tenantId, session, [req.rule], now(), req.rescanId);
        if (signals.length > 0) {
          await deps.warehouse.insert('signals', signals.map((row) => ({ insertId: row.signal_id, row })));
          await Promise.all(
            signals.map((row) =>
              deps.publisher.publish(deps.signalsTopic, row, { attributes: { tenant_id: row.tenant_id, detector: row.detector, fingerprint: row.fingerprint, rescan_id: req.rescanId } }),
            ),
          );
          status.sessions_hit += 1;
          status.signals_written += signals.length;
        }
        status.sessions_scanned += 1;
        status.chunks_scanned += session.chunks.length;
        await progress();
      },
      onError: (sessionId, err) => {
        status.sessions_failed += 1;
        log.warn({ err, session_id: sessionId }, 're-scan could not read a session; skipped');
      },
    });
    Object.assign(status, {
      sessions_total: summary.sessions_total,
      sessions_scanned: summary.sessions_scanned,
      sessions_failed: summary.sessions_failed,
      chunks_scanned: summary.chunks_scanned,
      truncated: summary.truncated,
      status: 'done' as const,
      finished_at: now(),
    });
  } catch (err) {
    Object.assign(status, { status: 'failed' as const, finished_at: now(), error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    log.error({ err }, 're-scan failed');
  }
  await progress(true);
  log.info(
    { status: status.status, sessions: status.sessions_scanned, failed: status.sessions_failed, hit: status.sessions_hit, signals: status.signals_written, ms: (status.finished_at ?? now()) - status.started_at },
    're-scan finished',
  );
  return status;
}
