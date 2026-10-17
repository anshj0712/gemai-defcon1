import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Firestore } from '@google-cloud/firestore';
import type { Cluster, Finding, ProbeDoc, RuleDoc, SessionTail } from '@cp/schema';

/** Result of applying one signal to a cluster. */
export interface ClusterUpdate {
  /** False when the signal had been applied before (redelivery) or the update declined to write. */
  applied: boolean;
  cluster: Cluster | null;
}

/**
 * Hot state: the processor's session tails and processed-chunk markers, and the clusterer's live
 * clusters (the issues feed) with their applied-signal markers.
 */
export interface StateStore {
  getTail(tenantId: string, sessionId: string): Promise<SessionTail | null>;
  putTail(tail: SessionTail, ttlMs: number): Promise<void>;
  isProcessed(tenantId: string, sessionId: string, seq: number): Promise<boolean>;
  markProcessed(tenantId: string, sessionId: string, seq: number, ttlMs: number): Promise<void>;

  /**
   * Atomically: skip if `signalId` was already applied, otherwise write `update(current)` and mark the
   * signal applied. `update` returns null to write nothing (for example, a tenant over its cluster cap).
   */
  applyToCluster(tenantId: string, clusterId: string, signalId: string, update: (current: Cluster | null) => Cluster | null, markerTtlMs: number): Promise<ClusterUpdate>;
  getCluster(tenantId: string, clusterId: string): Promise<Cluster | null>;
  /** Most recently active first. */
  listClusters(tenantId: string, limit: number): Promise<Cluster[]>;
  countClusters(tenantId: string): Promise<number>;

  /**
   * Findings: the latest version of each, a hot copy of the bitemporal `findings` table for the feed.
   * Written by the agent service only; overwriting here is fine because BigQuery keeps every version.
   */
  putFinding(finding: Finding): Promise<void>;
  getFinding(tenantId: string, findingId: string): Promise<Finding | null>;
  /** Highest score first. */
  listFindings(tenantId: string, limit: number): Promise<Finding[]>;

  /**
   * Tenant rules (Phase 4): the approved version the processor runs, a pending draft, and the latest
   * re-scan. Written by the agent service only; the `rules` table keeps every approved version.
   */
  putRule(rule: RuleDoc): Promise<void>;
  getRule(tenantId: string, ruleId: string): Promise<RuleDoc | null>;
  /** Most recently updated first. */
  listRules(tenantId: string): Promise<RuleDoc[]>;

  /**
   * Recorded probes: a selector read from the recorded page, registered on the dashboard (or proposed by the agent
   * and approved with its rule). Written by the agent service only; the processor reads the active ones.
   */
  putProbe(probe: ProbeDoc): Promise<void>;
  getProbe(tenantId: string, name: string): Promise<ProbeDoc | null>;
  /** Most recently updated first. */
  listProbes(tenantId: string): Promise<ProbeDoc[]>;
}

export const TAILS_COLLECTION = 'session_tails';
export const PROCESSED_COLLECTION = 'processed_chunks';
export const CLUSTERS_COLLECTION = 'clusters';
export const CLUSTERED_COLLECTION = 'clustered_signals';
export const FINDINGS_COLLECTION = 'findings';
export const RULES_COLLECTION = 'rules';
export const PROBES_COLLECTION = 'probes';

/** Most rules one tenant may hold (a cardinality guard on the hot copy). */
export const MAX_RULES_PER_TENANT = 200;
/** Most recorded probes one tenant may hold. */
export const MAX_PROBES_PER_TENANT = 200;

const tailId = (tenantId: string, sessionId: string) => `${tenantId}__${sessionId}`;
const processedId = (tenantId: string, sessionId: string, seq: number) => `${tenantId}__${sessionId}__${seq}`;
const clusterDocId = (tenantId: string, clusterId: string) => `${tenantId}__${clusterId}`;
const clusteredId = (tenantId: string, signalId: string) => `${tenantId}__${signalId}`;
const findingDocId = (tenantId: string, findingId: string) => `${tenantId}__${findingId}`;
const ruleDocId = (tenantId: string, ruleId: string) => `${tenantId}__${ruleId}`;
const byUpdated = (a: RuleDoc, b: RuleDoc) => b.updated_at - a.updated_at || (a.rule_id < b.rule_id ? -1 : 1);
const probeDocId = (tenantId: string, name: string) => `${tenantId}__${name}`;
const probesByUpdated = (a: ProbeDoc, b: ProbeDoc) => b.updated_at - a.updated_at || (a.name < b.name ? -1 : 1);

/**
 * Firestore layout. The tail itself is stored as one gzipped JSON bytes field: it keeps the document
 * small and avoids indexing a large nested map. `expires_at` drives the Firestore TTL policy.
 */
export class FirestoreStateStore implements StateStore {
  constructor(private readonly db: Firestore) {}

  async getTail(tenantId: string, sessionId: string): Promise<SessionTail | null> {
    const snap = await this.db.collection(TAILS_COLLECTION).doc(tailId(tenantId, sessionId)).get();
    if (!snap.exists) return null;
    const payload = snap.get('payload') as Uint8Array | undefined;
    if (!payload) return null;
    return JSON.parse(gunzipSync(payload).toString('utf8')) as SessionTail;
  }

  async putTail(tail: SessionTail, ttlMs: number): Promise<void> {
    await this.db
      .collection(TAILS_COLLECTION)
      .doc(tailId(tail.tenant_id, tail.session_id))
      .set({
        tenant_id: tail.tenant_id,
        session_id: tail.session_id,
        last_seq: tail.last_seq,
        horizon: tail.horizon,
        updated_at: new Date(tail.updated_at),
        expires_at: new Date(tail.updated_at + ttlMs),
        payload: gzipSync(JSON.stringify(tail)),
      });
  }

  async isProcessed(tenantId: string, sessionId: string, seq: number): Promise<boolean> {
    const snap = await this.db.collection(PROCESSED_COLLECTION).doc(processedId(tenantId, sessionId, seq)).get();
    return snap.exists;
  }

  async markProcessed(tenantId: string, sessionId: string, seq: number, ttlMs: number): Promise<void> {
    const now = Date.now();
    await this.db
      .collection(PROCESSED_COLLECTION)
      .doc(processedId(tenantId, sessionId, seq))
      .set({ tenant_id: tenantId, session_id: sessionId, seq, processed_at: new Date(now), expires_at: new Date(now + ttlMs) });
  }

  private clusterFields(c: Cluster) {
    // Queryable fields plus the whole cluster as gzipped JSON (the sessions list can be large).
    return {
      tenant_id: c.tenant_id,
      cluster_id: c.cluster_id,
      kind: c.kind,
      last_seen: c.last_seen,
      updated_at: new Date(c.updated_at),
      payload: gzipSync(JSON.stringify(c)),
    };
  }

  private decodeCluster(payload: unknown): Cluster | null {
    return payload instanceof Uint8Array ? (JSON.parse(gunzipSync(payload).toString('utf8')) as Cluster) : null;
  }

  async applyToCluster(
    tenantId: string,
    clusterId: string,
    signalId: string,
    update: (current: Cluster | null) => Cluster | null,
    markerTtlMs: number,
  ): Promise<ClusterUpdate> {
    const clusterRef = this.db.collection(CLUSTERS_COLLECTION).doc(clusterDocId(tenantId, clusterId));
    const markerRef = this.db.collection(CLUSTERED_COLLECTION).doc(clusteredId(tenantId, signalId));
    return this.db.runTransaction(async (tx) => {
      const [marker, snap] = await Promise.all([tx.get(markerRef), tx.get(clusterRef)]);
      const current = snap.exists ? this.decodeCluster(snap.get('payload')) : null;
      if (marker.exists) return { applied: false, cluster: current };
      const next = update(current);
      if (!next) return { applied: false, cluster: current };
      const now = Date.now();
      tx.set(clusterRef, this.clusterFields(next));
      tx.set(markerRef, { tenant_id: tenantId, cluster_id: clusterId, applied_at: new Date(now), expires_at: new Date(now + markerTtlMs) });
      return { applied: true, cluster: next };
    });
  }

  async getCluster(tenantId: string, clusterId: string): Promise<Cluster | null> {
    const snap = await this.db.collection(CLUSTERS_COLLECTION).doc(clusterDocId(tenantId, clusterId)).get();
    return snap.exists ? this.decodeCluster(snap.get('payload')) : null;
  }

  async listClusters(tenantId: string, limit: number): Promise<Cluster[]> {
    // Needs the composite index (tenant_id ASC, last_seen DESC) created by `pnpm infra:up`.
    const q = await this.db.collection(CLUSTERS_COLLECTION).where('tenant_id', '==', tenantId).orderBy('last_seen', 'desc').limit(limit).get();
    return q.docs.map((d) => this.decodeCluster(d.get('payload'))).filter((c): c is Cluster => c !== null);
  }

  async countClusters(tenantId: string): Promise<number> {
    const agg = await this.db.collection(CLUSTERS_COLLECTION).where('tenant_id', '==', tenantId).count().get();
    return agg.data().count;
  }

  async putFinding(f: Finding): Promise<void> {
    await this.db
      .collection(FINDINGS_COLLECTION)
      .doc(findingDocId(f.tenant_id, f.finding_id))
      .set({
        tenant_id: f.tenant_id,
        finding_id: f.finding_id,
        cluster_id: f.cluster_id,
        tier: f.tier,
        score: f.score,
        version: f.version,
        updated_at: new Date(f.updated_at),
        payload: gzipSync(JSON.stringify(f)),
      });
  }

  private decodeFinding(payload: unknown): Finding | null {
    return payload instanceof Uint8Array ? (JSON.parse(gunzipSync(payload).toString('utf8')) as Finding) : null;
  }

  async getFinding(tenantId: string, findingId: string): Promise<Finding | null> {
    const snap = await this.db.collection(FINDINGS_COLLECTION).doc(findingDocId(tenantId, findingId)).get();
    return snap.exists ? this.decodeFinding(snap.get('payload')) : null;
  }

  async listFindings(tenantId: string, limit: number): Promise<Finding[]> {
    // Needs the composite index (tenant_id ASC, score DESC) created by `pnpm infra:up`.
    const q = await this.db.collection(FINDINGS_COLLECTION).where('tenant_id', '==', tenantId).orderBy('score', 'desc').limit(limit).get();
    return q.docs.map((d) => this.decodeFinding(d.get('payload'))).filter((f): f is Finding => f !== null);
  }

  async putRule(r: RuleDoc): Promise<void> {
    await this.db
      .collection(RULES_COLLECTION)
      .doc(ruleDocId(r.tenant_id, r.rule_id))
      .set({ tenant_id: r.tenant_id, rule_id: r.rule_id, updated_at: new Date(r.updated_at), payload: gzipSync(JSON.stringify(r)) });
  }

  private decodeRule(payload: unknown): RuleDoc | null {
    return payload instanceof Uint8Array ? (JSON.parse(gunzipSync(payload).toString('utf8')) as RuleDoc) : null;
  }

  async getRule(tenantId: string, ruleId: string): Promise<RuleDoc | null> {
    const snap = await this.db.collection(RULES_COLLECTION).doc(ruleDocId(tenantId, ruleId)).get();
    return snap.exists ? this.decodeRule(snap.get('payload')) : null;
  }

  async listRules(tenantId: string): Promise<RuleDoc[]> {
    // Equality filter only, so the automatic single-field index serves it; sorted here.
    const q = await this.db.collection(RULES_COLLECTION).where('tenant_id', '==', tenantId).limit(MAX_RULES_PER_TENANT).get();
    return q.docs.map((d) => this.decodeRule(d.get('payload'))).filter((r): r is RuleDoc => r !== null).sort(byUpdated);
  }

  async putProbe(p: ProbeDoc): Promise<void> {
    await this.db
      .collection(PROBES_COLLECTION)
      .doc(probeDocId(p.tenant_id, p.name))
      .set({ tenant_id: p.tenant_id, name: p.name, status: p.status, updated_at: new Date(p.updated_at), payload: gzipSync(JSON.stringify(p)) });
  }

  private decodeProbe(payload: unknown): ProbeDoc | null {
    return payload instanceof Uint8Array ? (JSON.parse(gunzipSync(payload).toString('utf8')) as ProbeDoc) : null;
  }

  async getProbe(tenantId: string, name: string): Promise<ProbeDoc | null> {
    const snap = await this.db.collection(PROBES_COLLECTION).doc(probeDocId(tenantId, name)).get();
    return snap.exists ? this.decodeProbe(snap.get('payload')) : null;
  }

  async listProbes(tenantId: string): Promise<ProbeDoc[]> {
    // Equality filter only (automatic single-field index); sorted here.
    const q = await this.db.collection(PROBES_COLLECTION).where('tenant_id', '==', tenantId).limit(MAX_PROBES_PER_TENANT).get();
    return q.docs.map((d) => this.decodeProbe(d.get('payload'))).filter((p): p is ProbeDoc => p !== null).sort(probesByUpdated);
  }
}

/** local mode: one JSON file per document under `<dir>/<collection>/`. No TTL; `pnpm clean` wipes it. */
export class LocalStateStore implements StateStore {
  /** Serializes read-modify-write per cluster within this process (the local stand-in for a transaction). */
  private readonly clusterChains = new Map<string, Promise<unknown>>();
  private writes = 0;

  constructor(private readonly dir: string) {}

  private path(collection: string, id: string): string {
    return join(this.dir, collection, `${id}.json`);
  }

  private async write(collection: string, id: string, doc: unknown): Promise<void> {
    await mkdir(join(this.dir, collection), { recursive: true });
    // Write then rename, so a concurrent reader (the API) never sees a half-written document.
    const file = this.path(collection, id);
    const tmp = `${file}.${process.pid}.${++this.writes}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, file);
  }

  async getTail(tenantId: string, sessionId: string): Promise<SessionTail | null> {
    const file = this.path(TAILS_COLLECTION, tailId(tenantId, sessionId));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as SessionTail;
  }

  async putTail(tail: SessionTail): Promise<void> {
    await this.write(TAILS_COLLECTION, tailId(tail.tenant_id, tail.session_id), tail);
  }

  async isProcessed(tenantId: string, sessionId: string, seq: number): Promise<boolean> {
    return existsSync(this.path(PROCESSED_COLLECTION, processedId(tenantId, sessionId, seq)));
  }

  async markProcessed(tenantId: string, sessionId: string, seq: number): Promise<void> {
    await this.write(PROCESSED_COLLECTION, processedId(tenantId, sessionId, seq), {
      tenant_id: tenantId,
      session_id: sessionId,
      seq,
      processed_at: Date.now(),
    });
  }

  /** `_markerTtlMs` is ignored locally: there is no TTL, and `pnpm clean` wipes the markers. */
  applyToCluster(tenantId: string, clusterId: string, signalId: string, update: (current: Cluster | null) => Cluster | null, _markerTtlMs?: number): Promise<ClusterUpdate> {
    const key = clusterDocId(tenantId, clusterId);
    const task = async (): Promise<ClusterUpdate> => {
      const current = await this.getCluster(tenantId, clusterId);
      if (existsSync(this.path(CLUSTERED_COLLECTION, clusteredId(tenantId, signalId)))) return { applied: false, cluster: current };
      const next = update(current);
      if (!next) return { applied: false, cluster: current };
      await this.write(CLUSTERS_COLLECTION, key, next);
      await this.write(CLUSTERED_COLLECTION, clusteredId(tenantId, signalId), { tenant_id: tenantId, cluster_id: clusterId, applied_at: Date.now() });
      return { applied: true, cluster: next };
    };
    const prev = this.clusterChains.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.clusterChains.set(key, next);
    const cleanup = () => {
      if (this.clusterChains.get(key) === next) this.clusterChains.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  async getCluster(tenantId: string, clusterId: string): Promise<Cluster | null> {
    const file = this.path(CLUSTERS_COLLECTION, clusterDocId(tenantId, clusterId));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as Cluster;
  }

  private async allClusters(tenantId: string): Promise<Cluster[]> {
    const dir = join(this.dir, CLUSTERS_COLLECTION);
    if (!existsSync(dir)) return [];
    const prefix = `${tenantId}__`;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Cluster));
  }

  async listClusters(tenantId: string, limit: number): Promise<Cluster[]> {
    return (await this.allClusters(tenantId)).sort((a, b) => b.last_seen - a.last_seen).slice(0, limit);
  }

  async countClusters(tenantId: string): Promise<number> {
    return (await this.allClusters(tenantId)).length;
  }

  async putFinding(f: Finding): Promise<void> {
    await this.write(FINDINGS_COLLECTION, findingDocId(f.tenant_id, f.finding_id), f);
  }

  async getFinding(tenantId: string, findingId: string): Promise<Finding | null> {
    const file = this.path(FINDINGS_COLLECTION, findingDocId(tenantId, findingId));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as Finding;
  }

  async listFindings(tenantId: string, limit: number): Promise<Finding[]> {
    const dir = join(this.dir, FINDINGS_COLLECTION);
    if (!existsSync(dir)) return [];
    const prefix = `${tenantId}__`;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Finding));
    return all.sort((a, b) => b.score - a.score || b.last_seen - a.last_seen).slice(0, limit);
  }

  async putRule(r: RuleDoc): Promise<void> {
    await this.write(RULES_COLLECTION, ruleDocId(r.tenant_id, r.rule_id), r);
  }

  async getRule(tenantId: string, ruleId: string): Promise<RuleDoc | null> {
    const file = this.path(RULES_COLLECTION, ruleDocId(tenantId, ruleId));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as RuleDoc;
  }

  async listRules(tenantId: string): Promise<RuleDoc[]> {
    const dir = join(this.dir, RULES_COLLECTION);
    if (!existsSync(dir)) return [];
    const prefix = `${tenantId}__`;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as RuleDoc));
    return all.sort(byUpdated).slice(0, MAX_RULES_PER_TENANT);
  }

  async putProbe(p: ProbeDoc): Promise<void> {
    await this.write(PROBES_COLLECTION, probeDocId(p.tenant_id, p.name), p);
  }

  async getProbe(tenantId: string, name: string): Promise<ProbeDoc | null> {
    const file = this.path(PROBES_COLLECTION, probeDocId(tenantId, name));
    if (!existsSync(file)) return null;
    return JSON.parse(await readFile(file, 'utf8')) as ProbeDoc;
  }

  async listProbes(tenantId: string): Promise<ProbeDoc[]> {
    const dir = join(this.dir, PROBES_COLLECTION);
    if (!existsSync(dir)) return [];
    const prefix = `${tenantId}__`;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as ProbeDoc));
    return all.sort(probesByUpdated).slice(0, MAX_PROBES_PER_TENANT);
  }
}
