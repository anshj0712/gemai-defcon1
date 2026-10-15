import type { Detector, InvariantRule, NormalizedChunk, SessionContext, Signal } from '@cp/schema';
import { deadClick } from './dead-click.js';
import { errorCorrelation } from './error-correlation.js';
import { shortHash, stableStringify } from './fingerprint.js';
import { invariantCheck } from './invariant-check.js';
import { rageClick } from './rage-click.js';
import { responseDecay } from './response-decay.js';

export { deadClick } from './dead-click.js';
export { errorCorrelation } from './error-correlation.js';
export { fingerprint, normalizeSelector, routeTemplate, shortHash, stableStringify } from './fingerprint.js';
export { invariantCheck } from './invariant-check.js';
export { rageClick } from './rage-click.js';
export { responseDecay } from './response-decay.js';
export { BUILTIN_RULES, checkRule, evaluate } from './rules.js';
export { signalId, signalRuleVersion, toSignalRows, type SignalRowContext } from './signal-rows.js';

/** Every registered detector. Adding one here is the only wiring a new detector needs. */
export const DETECTORS: readonly Detector[] = [deadClick, rageClick, responseDecay, invariantCheck, errorCorrelation];

/** Tenant overrides: detector id -> param name -> value. */
export type ParamOverrides = Record<string, Record<string, number | string>>;

/** Defaults merged with overrides. Unknown params and values of the wrong type are ignored. */
export function effectiveParams(detector: Detector, overrides?: Record<string, number | string>): Record<string, number | string> {
  const params = { ...detector.params };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    const def = detector.params[k];
    if (def !== undefined && typeof v === typeof def) params[k] = v;
  }
  return params;
}

/**
 * Version of the rule a builtin detector ran under: a hash of its effective params. A threshold change
 * yields a new rule_version, so signals stay explainable and re-scans can tell old from new.
 */
export function ruleVersion(params: Record<string, number | string>): string {
  return `p${shortHash(stableStringify(params), 8)}`;
}

export interface DetectorRun {
  detector: Detector;
  params: Record<string, number | string>;
  ruleVersion: string;
  signals: Signal[];
  /** Present when the detector returned state to carry into the session's next chunk. */
  state?: unknown;
  /** Set when the detector threw; the other detectors still run and its previous state is kept. */
  error?: Error;
}

export interface RunExtras {
  /** detector id -> the state that detector returned for this session's previous chunk. */
  state?: Record<string, unknown>;
  /** Active invariant rules for the tenant (built-in rules when omitted). */
  rules?: InvariantRule[];
}

/**
 * Run every detector over one chunk, in two passes: primary detectors first, then correlating
 * detectors, which see the primary signals. A detector that throws is isolated.
 */
export function runDetectors(
  detectors: readonly Detector[],
  ctx: Omit<SessionContext, 'params' | 'state' | 'signals' | 'rules'>,
  chunk: NormalizedChunk,
  overrides: ParamOverrides = {},
  extras: RunExtras = {},
): DetectorRun[] {
  const runOne = (detector: Detector, signals?: Signal[]): DetectorRun => {
    const params = effectiveParams(detector, overrides[detector.id]);
    const base = { detector, params, ruleVersion: ruleVersion(params) };
    try {
      const out = detector.run(
        {
          ...ctx,
          params,
          ...(extras.state && detector.id in extras.state ? { state: extras.state[detector.id] } : {}),
          ...(signals ? { signals } : {}),
          ...(extras.rules ? { rules: extras.rules } : {}),
        },
        chunk,
      );
      if (Array.isArray(out)) return { ...base, signals: out };
      return { ...base, signals: out.signals, ...('state' in out ? { state: out.state } : {}) };
    } catch (err) {
      return { ...base, signals: [], error: err instanceof Error ? err : new Error(String(err)) };
    }
  };
  const primary = detectors.filter((d) => (d.phase ?? 'primary') === 'primary').map((d) => runOne(d));
  const primarySignals = primary.flatMap((r) => r.signals);
  const correlating = detectors.filter((d) => d.phase === 'correlate').map((d) => runOne(d, primarySignals));
  return [...primary, ...correlating];
}
