import { say, URLS } from './browser.js';
import type { FindingLike } from './truth.js';

/** Small API client for the exit-test scripts (sim:check, sim:rescan). All data they read is synthetic. */

/** A deployed API asks for a password (HTTP Basic, any user name): set API_PASSWORD to read it from these scripts. */
const auth: Record<string, string> = process.env.API_PASSWORD ? { authorization: `Basic ${Buffer.from(`sim:${process.env.API_PASSWORD}`).toString('base64')}` } : {};

export const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${URLS.api}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

export const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${URLS.api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status}${json.message ? `: ${json.message}` : ''}`);
  return json;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClusterSummary {
  cluster_id: string;
  kind: string;
  anchor: string;
  signal_count: number;
  last_seen: number;
}

/** Poll until the total signal count stops changing for `settleS` seconds (or `maxS` pass). */
export async function waitForQuiet(settleS: number, maxS = 180): Promise<ClusterSummary[]> {
  const deadline = Date.now() + maxS * 1000;
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const { clusters } = await get<{ clusters: ClusterSummary[] }>('/v1/clusters?limit=200');
    const total = clusters.reduce((n, c) => n + c.signal_count, 0);
    if (total !== last) {
      last = total;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleS * 1000) return clusters;
    if (Date.now() > deadline) {
      say(`  pipeline still busy after ${maxS} s; scoring what has landed`);
      return clusters;
    }
    await sleep(1000);
  }
}

/** Wait (up to `waitS`) until each issue has a finding with agent output (and `ready`, when given). */
export async function waitForFindings(clusterIds: string[], waitS: number, ready: (f: FindingLike) => boolean = (f) => f.triage !== null): Promise<Map<string, FindingLike>> {
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const found = new Map<string, FindingLike>();
    for (const id of clusterIds) {
      const r = await get<{ finding: FindingLike }>(`/v1/findings/${id}`).catch(() => null);
      if (r?.finding) found.set(id, r.finding);
    }
    if (clusterIds.every((id) => found.has(id) && ready(found.get(id)!)) || Date.now() > deadline) return found;
    await sleep(2000);
  }
}
