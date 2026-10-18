import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkRule } from '@cp/detectors';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader, type Publisher, type PublishOptions } from '@cp/platform';
import { RuleAuthorOutput, ruleText, type RuleAuthorOutput as AuthorOut, type SignalRow, type StoredChunk } from '@cp/schema';
import { SessionScript, toEnvelopes } from '@cp/testkit';
import { offlineRuleAuthor } from '../src/llm/offline-rules.js';
import { OfflineLlm } from '../src/llm/offline.js';
import type { ModelSet } from '../src/llm/models.js';
import { compileRule, validateRuleAuthor, type AuthorContext } from '../src/rules/compile.js';
import { buildCatalog, checkSession, dryRun } from '../src/rules/evaluate.js';
import { scanWindow, type SessionProbes } from '../src/rules/scan.js';
import { createRuleService, RuleError } from '../src/rules/service.js';
import { buildAgentServer } from '../src/server.js';
import { quiet, RecordedLlm, T } from './helpers.js';

/** All sessions are synthetic. The `qty_price` sessions carry consistent totals with a line priced 100x. */

const SENTENCE = 'No pair of shoes costs more than ₹17,000, so the bag subtotal must never be more than ₹17,000 times the number of pairs.';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as AuthorOut;

class RecordingPublisher implements Publisher {
  readonly messages: { topic: string; data: unknown; opts: PublishOptions }[] = [];
  async publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<string> {
    this.messages.push({ topic, data, opts });
    return String(this.messages.length);
  }
  async close(): Promise<void> {}
}

let dir: string;
let blob: LocalBlobStore;
let warehouse: LocalWarehouse;
let reader: LocalWarehouseReader;
let state: LocalStateStore;
let publisher: RecordingPublisher;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-rules-'));
  blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  reader = new LocalWarehouseReader(warehouse);
  state = new LocalStateStore(join(dir, 'firestore'));
  publisher = new RecordingPublisher();
});

/** Store a session's batches the way the collector and processor would (raw chunk + index row), +40 ms skew. */
async function seed(sessionId: string, start: number, probes: Record<string, number[]>[]): Promise<number[]> {
  const script = new SessionScript(start).meta(0).snapshot(5);
  probes.forEach((p, i) => script.probe(1000 + i * 1000, p));
  const times: number[] = probes.map((_, i) => start + 1000 + i * 1000 + 40);
  for (const env of toEnvelopes(script.events, { sessionId, batchMs: 5000 })) {
    const { site_key: _k, ...envelope } = env;
    const receivedAt = env.client_sent_at + 40;
    const doc: StoredChunk = { v: 1, tenant_id: 'demo', collector_received_at: receivedAt, envelope };
    const body = gzipSync(JSON.stringify(doc));
    const { uri } = await blob.putIfAbsent(`raw/demo/${sessionId}/${String(env.seq).padStart(8, '0')}.json.gz`, body, 'application/gzip');
    await warehouse.insert('raw_chunks', [
      {
        insertId: `demo:${sessionId}:${env.seq}`,
        row: {
          tenant_id: 'demo',
          session_id: sessionId,
          seq: env.seq,
          gcs_uri: uri,
          bytes: body.length,
          event_count: env.events.length,
          event_time_start: env.client_ts_start + 40,
          event_time_end: env.client_ts_end + 40,
          ingest_time: receivedAt + 100,
          client_sent_at: env.client_sent_at,
          collector_received_at: receivedAt,
          release: env.release,
          route: env.page.route,
          sdk_version: env.sdk_version,
          sample_rate: 1,
        },
      },
    ]);
  }
  return times;
}

const inflated = { line_total: [139_900_000], qty: [2], discount: [0], cart_total: [139_900_000] };
const clean = { line_total: [699_500], qty: [1], discount: [0], cart_total: [699_500] };

async function seedDemo() {
  const bugTimes = await seed('s_qty_price_0001', T, [clean, inflated]);
  await seed('s_clean_00000001', T + 60_000, [clean]);
  await seed('s_noprobe_000001', T + 120_000, []);
  return { bugTimes };
}

const ctx = (): AuthorContext => ({
  probes: new Set(['cart_total', 'discount', 'line_total', 'qty']),
  routes: new Set(['/cart']),
  evidenceIds: new Set(['S1', 'P1', 'P2', 'P3', 'P4']),
  reservedIds: new Set(['cart_total_matches_lines']),
});

describe('compileRule', () => {
  it('compiles the flat form into the detector rule, folding lte tolerance into the right side', () => {
    const out = fixture('rule-author.bag-cap');
    const rule = compileRule({ ...out, tolerance_minor: 5 }, 3);
    expect(rule).toMatchObject({ id: 'bag_subtotal_per_pair_cap', version: 3, requires: ['line_total', 'qty'], highlight_probe: 'line_total' });
    expect(ruleText(rule)).toBe('sum(line_total) ≤ 17,00,000 × sum(qty) + 5');
    expect(rule.assert.tolerance_minor).toBe(0);
    expect(checkRule(rule, { line_total: [3_400_005], qty: [2] }, '/cart').ok).toBe(true);
    expect(checkRule(rule, { line_total: [3_400_006], qty: [2] }, '/cart').ok).toBe(false);
  });

  it('keeps eq tolerance on the rule and treats default_zero probes as optional', () => {
    const out = offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text: 'The cart total must equal the line items minus the discount' }, ...['cart_total', 'discount', 'line_total'].map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }))] });
    const rule = compileRule(out, 1);
    expect(rule.requires).toEqual(['cart_total', 'line_total']);
    expect(rule.assert.tolerance_minor).toBe(1);
    expect(ruleText(rule)).toBe('cart_total = sum(line_total) − discount (within 1)');
  });
});

describe('validateRuleAuthor', () => {
  it('accepts a grounded rule', () => {
    expect(validateRuleAuthor(fixture('rule-author.bag-cap'), ctx())).toEqual([]);
  });

  it('rejects unknown evidence ids, probes, routes, built-in ids and fractional tolerance', () => {
    const good = fixture('rule-author.bag-cap');
    const errs = (o: Partial<AuthorOut>) => validateRuleAuthor({ ...good, ...o }, ctx()).join(' | ');
    expect(errs({ explanation: { text: 'x', evidence_ids: ['S1', 'P9'] } })).toMatch(/not supplied: P9/);
    expect(errs({ left: [{ ...good.left[0]!, probe: 'shipping' }] })).toMatch(/probe "shipping" does not exist/);
    expect(errs({ routes: ['/admin'] })).toMatch(/unknown routes: \/admin/);
    expect(errs({ rule_id: 'cart_total_matches_lines' })).toMatch(/built-in rule/);
    expect(errs({ tolerance_minor: 0.5 })).toMatch(/tolerance_minor/);
    expect(errs({ left: [{ ...good.left[0]!, kind: 'const', probe: '', value: 1 }], right: [{ ...good.right[0]!, kind: 'const', probe: '', value: 2 }] })).toMatch(/at least one probe/);
  });

  it('lets a not-understood answer through (the caller reports it)', () => {
    expect(validateRuleAuthor({ ...fixture('rule-author.bag-cap'), understood: false, rule_id: '', left: [], right: [] }, ctx())).toEqual([]);
  });

  it('matches the zod schema used for Gemini structured output', () => {
    expect(RuleAuthorOutput.safeParse(fixture('rule-author.bag-cap')).success).toBe(true);
  });
});

describe('offline rule author', () => {
  const probes = ['cart_total', 'discount', 'line_total', 'qty'].map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }));
  const author = (text: string) => offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text }, ...probes] });

  it('understands the demo sentence as a per-pair cap on the bag subtotal', () => {
    const out = author(SENTENCE);
    expect(out.title).toBe('Bag subtotal is more than ₹17,000 a pair');
    expect(validateRuleAuthor(out, ctx())).toEqual([]);
    expect(ruleText(compileRule(out, 1))).toBe('sum(line_total) ≤ 17,00,000 × sum(qty)');
  });

  it('understands a discount cap', () => {
    const rule = compileRule(author('The discount must never be more than 10% of the bag'), 1);
    expect(checkRule(rule, { discount: [100], line_total: [1000] }, '/cart').ok).toBe(true);
    expect(checkRule(rule, { discount: [200], line_total: [1000] }, '/cart').ok).toBe(false);
  });

  it('says so when it cannot express a sentence', () => {
    const out = author('Shipping must be free on Sundays');
    expect(out.understood).toBe(false);
    expect(out.explanation.text).toMatch(/GOOGLE_API_KEY/);
  });
});

describe('scan, evaluate and dry run (from raw)', () => {
  it('reads probe snapshots back from raw chunks and builds the catalog', async () => {
    await seedDemo();
    const sessions: SessionProbes[] = [];
    const summary = await scanWindow({ reader, blob }, { tenantId: 'demo', fromMs: T - 1, toMs: T + 3_600_000, maxSessions: 10, concurrency: 2, onSession: (s) => void sessions.push(s) });
    expect(summary).toMatchObject({ sessions_total: 3, sessions_scanned: 3, sessions_failed: 0, truncated: false });
    const catalog = buildCatalog(sessions);
    expect(catalog.probes.map((p) => p.name)).toEqual(['cart_total', 'discount', 'line_total', 'qty']);
    expect(catalog.probes.find((p) => p.name === 'qty')).toMatchObject({ min: 1, max: 2, routes: ['/cart'] });
    expect(catalog).toMatchObject({ routes: ['/cart'], currencies: ['INR'], sessions: 2 });
  });

  it('flags exactly what live detection would, with the original valid time', async () => {
    const { bugTimes } = await seedDemo();
    const rule = compileRule(fixture('rule-author.bag-cap'), 1);
    const sessions: SessionProbes[] = [];
    await scanWindow({ reader, blob }, { tenantId: 'demo', fromMs: T - 1, toMs: T + 3_600_000, maxSessions: 10, concurrency: 2, onSession: (s) => void sessions.push(s) });
    const bug = sessions.find((s) => s.session_id === 's_qty_price_0001')!;
    const check = checkSession('demo', bug, [rule], 999, 'rs_x');
    expect(check.applicable).toBe(2);
    expect(check.signals).toHaveLength(1);
    expect(check.signals[0]).toMatchObject({ rule_version: 'bag_subtotal_per_pair_cap@1', event_time: bugTimes[1], ingest_time: 999, rescan_id: 'rs_x', route: '/cart' });

    const preview = dryRun({ tenantId: 'demo', rule, sessions, window: { from: 0, to: 1 }, inIssues: new Set(), truncated: false, now: 10, startedAt: 4 });
    expect(preview).toMatchObject({ sessions_scanned: 3, sessions_applicable: 2, sessions_hit: 1, hit_rate: 0.5, hits_in_issues: 0, ms: 6 });
    expect(preview.samples[0]).toMatchObject({ session_id: 's_qty_price_0001', left: 139_900_000, right: 3_400_000 });
  });
});

describe('rule service', () => {
  const offline = new OfflineLlm();
  const models = (m: ModelSet['reasoning'] = offline, isOffline = true): ModelSet => ({ bulk: m, reasoning: m, offline: isOffline });
  let clock = T + 3_600_000;
  const service = (m = models()) =>
    createRuleService({
      state,
      warehouse,
      reader,
      blob,
      publisher,
      signalsTopic: 'signals',
      models: m,
      logger: quiet,
      tenants: ['demo'],
      dryRun: { sessions: 100, days: 30 },
      rescan: { sessions: 100, days: 30, concurrency: 2 },
      revenue: { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 },
      runOptions: { sleep: async () => {}, backoffMs: 1 },
      now: () => clock,
    });

  it('drafts with a dry run, then on approval records the rule and re-scans history', async () => {
    const { bugTimes } = await seedDemo();
    const rules = service();
    const doc = await rules.draft('demo', SENTENCE);
    expect(doc).toMatchObject({ rule_id: 'bag_subtotal_per_pair_cap', active: null, draft: { rule: { version: 1 }, author: { offline: true, model: 'offline-stand-in' } } });
    expect(doc.draft!.dry_run).toMatchObject({ sessions_scanned: 3, sessions_hit: 1 });
    expect(await warehouse.rows('signals')).toEqual([]); // a draft writes no signals

    clock += 60_000;
    const approvedAt = clock;
    const approved = await rules.approve('demo', doc.rule_id, 1, 'test-merchant');
    expect(approved).toMatchObject({ active: { approved_by: 'test-merchant', approved_at: approvedAt, origin: 'human' }, draft: null, versions: [{ version: 1, approved_at: approvedAt }] });
    expect(approved.rescan?.status).toBe('running');
    await rules.idle();

    const ruleRows = await warehouse.rows('rules');
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).toMatchObject({ rule_id: 'bag_subtotal_per_pair_cap', version: 1, kind: 'generated', created_by: 'test-merchant', recorded_at: approvedAt, definition: { type: 'invariant', sentence: SENTENCE } });

    const after = (await state.getRule('demo', doc.rule_id))!;
    expect(after.rescan).toMatchObject({ status: 'done', sessions_total: 3, sessions_scanned: 3, sessions_hit: 1, signals_written: 1 });
    const signals = (await warehouse.rows('signals')) as unknown as SignalRow[];
    expect(signals).toHaveLength(1);
    // Bitemporal: valid time is when the shopper saw it; transaction time is the re-scan.
    expect(signals[0]).toMatchObject({ session_id: 's_qty_price_0001', event_time: bugTimes[1], ingest_time: approvedAt, rescan_id: after.rescan!.rescan_id });
    expect(publisher.messages.map((m) => m.topic)).toEqual(['signals']);

    // Re-running the re-scan writes nothing twice (idempotent by signal id).
    clock += 60_000;
    await rules.rescan('demo', doc.rule_id);
    await rules.idle();
    expect(await warehouse.rows('signals')).toHaveLength(1);
    expect((await state.getRule('demo', doc.rule_id))!.rescan).toMatchObject({ status: 'done', signals_written: 1 });
  });

  it('undo switches a live rule off, keeps what it found, and records the undo as a new row', async () => {
    await seedDemo();
    const rules = service();
    const doc = await rules.draft('demo', SENTENCE);
    clock += 60_000;
    await rules.approve('demo', doc.rule_id, 1, 'm');
    await rules.idle();
    expect(await warehouse.rows('signals')).toHaveLength(1);

    clock += 60_000;
    const undoneAt = clock;
    const off = await rules.undo('demo', doc.rule_id, 'm');
    expect(off).toMatchObject({ active: null, undone: [{ version: 1, undone_at: undoneAt, undone_by: 'm' }] });
    expect(await rules.activeRules('demo')).not.toContainEqual(expect.objectContaining({ id: doc.rule_id }));
    // Nothing erased or changed in place: the signal stays, and the undo is an added row beside the approval.
    expect(await warehouse.rows('signals')).toHaveLength(1);
    const ruleRows = await warehouse.rows('rules');
    expect(ruleRows).toHaveLength(2);
    expect(ruleRows[1]).toMatchObject({ rule_id: doc.rule_id, definition: { type: 'invariant_undone', undone_by: 'm' }, recorded_at: undoneAt });

    // A second click does nothing more.
    expect((await rules.undo('demo', doc.rule_id, 'm')).undone).toHaveLength(1);
    expect(await warehouse.rows('rules')).toHaveLength(2);
  });

  it('drafts with Gemini from a recorded answer and records the model', async () => {
    await seedDemo();
    const gemini = new RecordedLlm({ rule_author: [fixture('rule-author.bag-cap')] }, 'gemini-3.8-flash');
    const doc = await service(models(gemini, false)).draft('demo', SENTENCE);
    expect(doc.draft?.author).toMatchObject({ model: 'gemini-3.8-flash', offline: false, evidence_ids: ['S1', 'P3', 'P4'] });
    const req = gemini.requests[0]!;
    const text = (req.contents.at(-1)?.parts ?? []).map((p) => p.text ?? '').join('');
    // The model sees the sentence and probe statistics only: no session ids, no events.
    expect(text).toContain(SENTENCE);
    expect(text).not.toMatch(/s_qty_price|s_clean|rrweb|"events"/);
  });

  it('fails closed when the model keeps citing evidence it was not given', async () => {
    await seedDemo();
    const liar = new RecordedLlm({ rule_author: [{ ...fixture('rule-author.bag-cap'), explanation: { text: 'x', evidence_ids: ['P9'] } }] });
    const err = await service(models(liar, false))
      .draft('demo', SENTENCE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleError);
    expect(err).toMatchObject({ code: 'author_failed', status: 502 });
    expect(liar.calls('rule_author')).toBe(2);
    expect(await state.listRules('demo')).toEqual([]);
  });

  it('refuses a stale version, an unknown tenant, and a store with no probes', async () => {
    const rules = service();
    await expect(rules.draft('demo', SENTENCE)).rejects.toMatchObject({ code: 'no_probes' });
    await seedDemo();
    const doc = await rules.draft('demo', SENTENCE);
    await expect(rules.approve('demo', doc.rule_id, 2, 'm')).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(rules.draft('other', SENTENCE)).rejects.toMatchObject({ code: 'unknown_tenant' });
    await expect(rules.draft('demo', 'Shipping must be free on Sundays')).rejects.toMatchObject({ code: 'not_understood', status: 422 });
  });

  it('marks a re-scan left running by a previous process as interrupted', async () => {
    await seedDemo();
    const doc = await service().draft('demo', SENTENCE);
    await state.putRule({ ...doc, rescan: { rescan_id: 'rs_old', rule_version: 'x@1', status: 'running', window: { from: 0, to: 1 }, started_at: 1, finished_at: null, sessions_total: 0, sessions_scanned: 0, sessions_failed: 0, chunks_scanned: 0, sessions_hit: 0, signals_written: 0, truncated: false, error: null } });
    expect(await service().markInterrupted()).toBe(1);
    expect((await state.getRule('demo', doc.rule_id))!.rescan).toMatchObject({ status: 'interrupted' });
  });

  it('serves the rule actions over HTTP', async () => {
    await seedDemo();
    const app = buildAgentServer({ logger: quiet, runPass: async () => [], info: {}, rules: service() });
    const draft = await app.inject({ method: 'POST', url: '/rules/draft', payload: { tenant: 'demo', sentence: SENTENCE } });
    expect(draft.statusCode).toBe(200);
    const id = (draft.json() as { rule: { rule_id: string } }).rule.rule_id;
    expect((await app.inject({ method: 'POST', url: '/rules/draft', payload: { tenant: 'demo', sentence: 'Shipping must be free on Sundays' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/rules/draft', payload: { tenant: 'bad tenant!', sentence: SENTENCE } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/approve`, payload: { tenant: 'demo', version: 9 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/rules/${id}/reject`, payload: { tenant: 'demo' } })).json()).toMatchObject({ rule: { draft: null } });
    await app.close();
  });
});
