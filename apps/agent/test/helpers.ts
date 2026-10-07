import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import { createLogger } from '@cp/logger';
import type { SessionOutcome } from '@cp/platform';
import type { Cluster, SignalRow } from '@cp/schema';
import { applySignal, clusterKeyFor } from '../../clusterer/src/cluster.js';

/** Test helpers. All sessions are synthetic. */

export const T = 1_790_000_000_000;
export const quiet = createLogger({ service: 'agent', format: 'json', level: 'silent', toCloud: false });

let n = 0;
export function signal(over: Partial<SignalRow> = {}, values: Record<string, unknown> = {}): SignalRow {
  n += 1;
  const session = over.session_id ?? 's_session_0001';
  return {
    signal_id: `sig-${n.toString().padStart(4, '0')}`,
    tenant_id: 'demo',
    session_id: session,
    seq: 0,
    detector: 'dead_click',
    detector_version: '1.3.0',
    rule_version: 'p1',
    fingerprint: 'fp-dead',
    route: '/cart',
    element_selector: 'button#apply-coupon',
    release: 'demo-shop@local',
    evidence: { sessionId: session, seq: 0, tStart: T + n, tEnd: T + n + 800, selector: 'button#apply-coupon', values: { window_ms: 800, node_id: 9, ...values } },
    event_time: T + n,
    ingest_time: T + 60_000,
    ...over,
  };
}

export function clusterOf(rows: readonly SignalRow[]): Cluster {
  let c: Cluster | null = null;
  for (const r of rows) c = applySignal(c, r, clusterKeyFor(r), T + 120_000);
  return c!;
}

/** The three demo bugs as clusters (synthetic): dead coupon button, cart total rule, failing Place Order. */
export function demoClusters(sessions = 10) {
  const ids = (p: string) => Array.from({ length: sessions }, (_, i) => `s_${p}_${String(i).padStart(4, '0')}`);
  const dead = clusterOf(ids('dead').flatMap((s) => [signal({ session_id: s }), signal({ session_id: s, detector: 'response_decay', fingerprint: 'fp-decay' }, { answered_before: 5, unanswered: 3 })]));
  const total = clusterOf(
    ids('total').map((s) =>
      signal(
        { session_id: s, detector: 'invariant_check', element_selector: null, fingerprint: 'fp-inv', rule_version: 'cart_total_matches_lines@1' },
        { rule_id: 'cart_total_matches_lines', rule_title: "Cart total doesn't match its line items", actual: 971550, expected: 2914650, currency: 'INR', highlight_probe: 'cart_total' },
      ),
    ),
  );
  const checkout = clusterOf(
    ids('checkout').flatMap((s) => [
      signal({ session_id: s, route: '/checkout', element_selector: 'button#place-order', detector: 'rage_click', fingerprint: 'fp-rage' }, { clicks: 5, span_ms: 2200, failed: 5 }),
      signal(
        { session_id: s, route: '/checkout', element_selector: 'button#place-order', detector: 'error_correlation', fingerprint: 'fp-err' },
        { error_signature: 'POST /api/orders 500', correlated_detector: 'rage_click' },
      ),
    ]),
  );
  return { dead, total, checkout, ids };
}

export function outcome(session_id: string, over: Partial<SessionOutcome> = {}): SessionOutcome {
  return { session_id, routes: ['/', '/cart', '/checkout'], releases: ['demo-shop@local'], first_seen: T, last_seen: T + 60_000, sample_rate: 1, cart_value_minor: 1_000_000, currency: 'INR', ordered: false, ...over };
}

/** A model that replays canned JSON answers per agent (hand-written fixtures in Gemini's response shape). */
export class RecordedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly answers: Record<string, (string | object)[]>,
    model = 'recorded-fixture',
  ) {
    super({ model });
  }

  override async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(req);
    const agent = String(req.config?.labels?.adk_agent_name ?? '');
    const queue = this.answers[agent];
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (next === undefined) {
      yield { errorCode: 'NO_FIXTURE', errorMessage: `no fixture for ${agent}` };
      return;
    }
    yield { content: { role: 'model', parts: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] } };
  }

  override connect(): never {
    throw new Error('no live mode');
  }

  calls(agent: string): number {
    return this.requests.filter((r) => r.config?.labels?.adk_agent_name === agent).length;
  }
}
