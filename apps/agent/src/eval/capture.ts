import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@cp/platform';
import type { Finding } from '@cp/schema';
import type { GoldenCase } from './score.js';

/**
 * `pnpm eval:capture -- --api https://<dashboard>`: turns the current findings of a run (after `pnpm sim`) into golden
 * cases, one per planted bug: the exact evidence pack the agents saw, plus what a correct report must mention (the
 * expectations below are written by hand from docs/DEMO_BUGS.md). Findings that match no planted bug are skipped.
 * All data is synthetic.
 */

const argv = process.argv.slice(2);
const val = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const say = (s: string) => process.stdout.write(`${s}\n`);

interface BugSpec {
  bug: string;
  /** Matches the finding's title, anchor and route (lower case). */
  match: RegExp;
  expect: GoldenCase['expect'];
}

const ANY = ['checkout_blocker', 'pricing_error', 'broken_control', 'error_spike', 'other'];

export const BUGS: BugSpec[] = [
  { bug: 'dead_button', match: /apply[- ]?coupon/, expect: { cause: [['coupon']], categories: ['broken_control'], where: ['coupon', 'apply'] } },
  { bug: 'checkout_error', match: /place[- ]?order|http 500/, expect: { cause: [['500', 'server error', 'failed', 'error']], categories: ['checkout_blocker', 'error_spike'], where: ['checkout', 'payment', 'order'] } },
  { bug: 'card_declined', match: /retry[- ]?card|another card/, expect: { cause: [['retry', 'another card', 'card']], categories: ['broken_control', 'checkout_blocker'], where: ['retry', 'card', 'payment'] } },
  { bug: 'cart_total', match: /cart total|line items/, expect: { cause: [['total'], ['line', 'item', 'subtotal', 'sum']], categories: ['pricing_error'], where: ['total', 'cart', 'calculation', 'discount'] } },
  { bug: 'ghost_line', match: /quantity decrease|decrease/, expect: { cause: [['quantity', 'decrease', 'remove']], categories: ['broken_control'], where: ['quantity', 'decrease', 'remove', 'cart'] } },
  { bug: 'returns_hidden', match: /returns/, expect: { cause: [['returns']], categories: ['broken_control'], where: ['returns'] } },
  { bug: 'support_down', match: /chat/, expect: { cause: [['chat', 'support']], categories: ['broken_control', 'error_spike', 'checkout_blocker'], where: ['chat', 'support'] } },
  { bug: 'recs_sold_out', match: /recommend|sold[- ]?out|rec-add/, expect: { cause: [['recommend', 'quick add', 'sold out', 'add']], categories: ['broken_control', 'other'], where: ['recommend', 'add', 'cart'] } },
  { bug: 'slow_payment', match: /payment authori[sz]ation|authorize/, expect: { cause: [['payment', 'authoriz']], categories: ANY, where: ['payment', 'authoriz', 'bank', 'gateway', 'latency', 'timeout'] } },
  { bug: 'slow_delivery', match: /delivery eta|eta exceeds/, expect: { cause: [['delivery', 'eta', 'estimate']], categories: ANY, where: ['delivery', 'eta', 'estimate', 'product'] } },
  { bug: 'shipping_shock', match: /delivery fee|shipping/, expect: { cause: [['fee', 'delivery', 'shipping']], categories: ANY, where: ['fee', 'delivery', 'shipping', 'checkout'] } },
];

async function main(): Promise<void> {
  const api = (val('api') ?? process.env.API_URL ?? 'http://localhost:8082').replace(/\/$/, '');
  const auth: Record<string, string> = process.env.API_PASSWORD ? { authorization: `Basic ${Buffer.from(`eval:${process.env.API_PASSWORD}`).toString('base64')}` } : {};
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${api}${path}`, { headers: auth });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const dir = join(findRepoRoot(), 'apps', 'agent', 'eval', 'golden');
  mkdirSync(dir, { recursive: true });
  const { findings } = await get<{ findings: Finding[] }>('/v1/findings?limit=200');
  const taken = new Set<string>();
  let n = 0;
  for (const summary of findings) {
    const hay = `${summary.title} ${summary.cluster_title} ${summary.anchor ?? ''} ${summary.route}`.toLowerCase();
    const spec = BUGS.find((b) => !taken.has(b.bug) && b.match.test(hay));
    if (!spec) {
      say(`  skip     ${summary.title}`);
      continue;
    }
    const { finding } = await get<{ finding: Finding }>(`/v1/findings/${summary.finding_id}`);
    // A golden evidence pack has no screenshot item: the eval asks without the image (root cause then answers from the evidence alone).
    const evidence = finding.evidence.filter((e) => e.kind !== 'screenshot');
    const golden: GoldenCase = {
      v: 1,
      id: `${spec.bug}`,
      bug: spec.bug,
      evidence,
      base_tier: finding.priority.base_tier,
      base_rule_ids: finding.priority.base_rule_ids,
      revenue: finding.revenue,
      affected_sessions: finding.affected_sessions,
      expect: spec.expect,
    };
    writeFileSync(join(dir, `${spec.bug}.json`), `${JSON.stringify(golden, null, 1)}\n`);
    taken.add(spec.bug);
    n += 1;
    say(`  captured ${spec.bug.padEnd(15)} ${evidence.length} evidence items  ${finding.title}`);
  }
  say(`${n} golden cases written to ${dir}`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('eval/capture.ts')) {
  main().catch((err: unknown) => {
    say(`eval:capture failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
