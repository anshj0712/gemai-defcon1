import type { InvariantRule } from './rules.js';

/**
 * The normalized event stream and the detector plugin contract (ARCHITECTURE.md section 4).
 * All times are epoch ms of valid time: client time corrected for clock skew.
 */

interface EventBase {
  /** Valid time, epoch ms (skew-corrected). */
  t: number;
  /** Sequence number of the chunk this event arrived in. */
  seq: number;
}

export interface ClickEvent extends EventBase {
  kind: 'click';
  /** rrweb node id of the resolved target (the nearest interactive ancestor when one exists). */
  nodeId: number;
  /** Node-local selector, for example `button#apply-coupon`; null when the node is unknown. */
  selector: string | null;
  tag: string | null;
  interactive: boolean;
  disabled: boolean;
  /** Route the page was on when the click happened (template or path); null if not yet known. */
  route: string | null;
  x?: number;
  y?: number;
}

export interface MutationEvent extends EventBase {
  kind: 'mutation';
  /** Number of adds, removes, text changes, and attribute changes in the record. */
  count: number;
}

export interface NavigationEvent extends EventBase {
  kind: 'navigation';
  reason: 'load' | 'spa' | 'unload';
  route: string | null;
}

export interface InputEvent extends EventBase {
  kind: 'input';
  nodeId: number;
}

export interface RequestEvent extends EventBase {
  kind: 'request';
  /** "start" events mark the call; "end" events carry the outcome. */
  phase: 'start' | 'end';
  /** `t` is always the request start; `tEnd` its completion (equal to `t` for a start event). */
  tEnd: number;
  method: string;
  route: string;
  /** HTTP status for "end" events (0 = network failure); 0 for "start" events. */
  status: number;
}

export interface ErrorEvent extends EventBase {
  kind: 'error';
  errorKind: 'error' | 'unhandledrejection';
  signature: string;
}

/** A snapshot of every registered probe at one moment (money in minor units, counts as integers). */
export interface ProbeEvent extends EventBase {
  kind: 'probe';
  values: Record<string, number[]>;
  currency: string | null;
  /** Route the page was on when the snapshot was taken. */
  route: string | null;
}

export type NormalizedEvent =
  | ClickEvent
  | MutationEvent
  | NavigationEvent
  | InputEvent
  | RequestEvent
  | ErrorEvent
  | ProbeEvent;

export interface NormalizedChunk {
  sessionId: string;
  seq: number;
  route: string;
  tStart: number;
  /** Decision horizon: the batch is known to cover every event up to this time. */
  tEnd: number;
  events: NormalizedEvent[];
}

/** Compact index of interactive DOM nodes, carried across chunks so clicks in later chunks resolve. */
export interface DomIndexEntry {
  selector: string;
  tag: string;
  interactive: boolean;
  disabled: boolean;
  /** The structural attributes the selector and flags derive from (id, class, role, type, ...). */
  attrs: Record<string, string>;
}

export interface NormalizerState {
  /** rrweb node id -> interactive element. */
  nodes: Record<string, DomIndexEntry>;
  /** rrweb node id of a descendant -> node id of its nearest interactive ancestor. */
  alias: Record<string, number>;
  /** Path of the page the last Meta event described; used to tell navigations from checkouts. */
  path: string | null;
  /** Current route, updated by page loads and SPA navigations, so each click knows where it happened. */
  route?: string | null;
}

export interface SessionContext {
  tenantId: string;
  sessionId: string;
  release: string;
  route: string;
  /** Normalized events from earlier chunks within the tail lookback, oldest first. */
  tail: NormalizedEvent[];
  /** Horizon of the previous chunk. Decisions due at or before it were already made; null for the first chunk. */
  prevHorizon: number | null;
  /** Effective parameters for the detector being run (defaults merged with tenant overrides). */
  params: Record<string, number | string>;
  /** This detector's state from the previous chunk of the session (whatever it last returned). */
  state?: unknown;
  /** Correlating detectors only: the signals the primary detectors produced for this chunk. */
  signals?: Signal[];
  /** Active invariant rules for the tenant. */
  rules?: InvariantRule[];
}

export interface SignalEvidence {
  sessionId: string;
  seq: number;
  tStart: number;
  tEnd: number;
  selector?: string;
  /** Route where the triggering event happened (a batch can span a navigation). */
  route?: string;
  values?: Record<string, unknown>;
}

export interface Signal {
  detector: string;
  /** hash(detector, route template, normalized selector, error signature) */
  fingerprint: string;
  /** Valid time, ms. */
  eventTime: number;
  evidence: SignalEvidence;
  /** Overrides the run's params-derived rule version (invariant_check: the rule's own version). */
  ruleVersion?: string;
}

/** What a detector may return when it carries state from one chunk to the next. State must be JSON. */
export interface DetectorOutput {
  signals: Signal[];
  state?: unknown;
}

export interface Detector {
  /** For example "dead_click". */
  id: string;
  /** Bumped on any logic change. */
  version: string;
  /** Default parameters; tenants override them through SessionContext.params. */
  params: Record<string, number | string>;
  /** 'primary' (default) runs first; 'correlate' runs after and sees primary signals in ctx.signals. */
  phase?: 'primary' | 'correlate';
  run(ctx: SessionContext, chunk: NormalizedChunk): Signal[] | DetectorOutput;
}

/** Per-session state the processor keeps between chunks (Firestore, cached in memory). */
export interface SessionTail {
  v: 1;
  tenant_id: string;
  session_id: string;
  last_seq: number;
  horizon: number;
  events: NormalizedEvent[];
  state: NormalizerState;
  /** detector id -> the state it returned for this session. */
  detector_state?: Record<string, unknown>;
  updated_at: number;
}
