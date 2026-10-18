import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RankOutput, RootCauseOutput, TriageOutput } from '@cp/schema';
import { BUGS } from '../src/eval/capture.js';
import { loadCases } from '../src/eval/run.js';
import { scoreJury, scoreRanker, scoreRootCause, scoreTriage, summarize, type CaseResult, type GoldenCase } from '../src/eval/score.js';

/** The eval engine's scorer must pass a good answer and fail wrong ones. Synthetic cases. */

const GOLDEN_DIR = join(__dirname, '..', 'eval', 'golden');

const claim = (text: string) => ({ text, evidence_ids: ['E1'] });
const triage = (over: Partial<TriageOutput> = {}): TriageOutput => ({
  title: 'Unresponsive Apply Coupon button on /cart',
  category: 'broken_control',
  confidence: 0.9,
  summary: claim('Shoppers press Apply Coupon and nothing happens.'),
  likely_cause: claim('The coupon handler stops responding after a few presses.'),
  repro_steps: [
    { step: 'Open the cart.', evidence_ids: ['E1'] },
    { step: 'Press Apply Coupon four times.', evidence_ids: ['E2'] },
  ],
  ...over,
});
const root = (over: Partial<RootCauseOutput> = {}): RootCauseOutput => ({
  hypothesis: claim('The apply handler ignores clicks after three presses.'),
  visual_check: 'not_checked',
  visual_notes: claim('No screenshot.'),
  suggested_fix_area: 'Coupon apply click handler on the cart page',
  ...over,
});
const dead: GoldenCase = {
  v: 1,
  id: 'dead_button',
  bug: 'dead_button',
  evidence: [],
  base_tier: 'P2',
  base_rule_ids: ['browse_friction'],
  revenue: { status: 'ok' } as GoldenCase['revenue'],
  affected_sessions: 10,
  expect: { cause: [['coupon']], categories: ['broken_control'], where: ['coupon', 'apply'] },
};

describe('scoring one case', () => {
  it('passes a report that names the defect, in the right category, with a place to look', () => {
    expect([...scoreTriage(dead, triage()), ...scoreRootCause(dead, root())].every((c) => c.pass)).toBe(true);
  });

  it('fails a report about something else, in the wrong category, or with uncited steps', () => {
    const other = triage({ title: 'Slow image loading on /home', summary: claim('Images load slowly.'), likely_cause: claim('A large banner image.'), repro_steps: [{ step: 'Open the home page.', evidence_ids: ['E1'] }, { step: 'Wait.', evidence_ids: ['E2'] }] });
    expect(scoreTriage(dead, other).find((c) => c.name === 'names_the_defect')?.pass).toBe(false);
    expect(scoreTriage(dead, triage({ category: 'pricing_error' })).find((c) => c.name === 'category')?.pass).toBe(false);
    expect(scoreTriage(dead, triage({ repro_steps: [{ step: 'a', evidence_ids: [] }, { step: 'b', evidence_ids: ['E1'] }] })).find((c) => c.name === 'repro_steps')?.pass).toBe(false);
  });

  it('fails a root cause that points somewhere unrelated, and any missing answer', () => {
    expect(scoreRootCause(dead, root({ suggested_fix_area: 'Image CDN settings', hypothesis: claim('The CDN is slow.') })).find((c) => c.name === 'where_to_look')?.pass).toBe(false);
    expect(scoreTriage(dead, null)[0]?.pass).toBe(false);
    expect(scoreRootCause(dead, null)[0]?.pass).toBe(false);
    expect(scoreRanker(null)[0]?.pass).toBe(false);
    expect(scoreRanker({ rule_ids: ['x'], tier_move: 'none', move_rule_id: '', reason: claim('ok') } satisfies RankOutput)[0]?.pass).toBe(true);
  });

  it('scores the jury only when it ran', () => {
    expect(scoreJury(null, null)).toEqual([]);
    expect(scoreJury('approved', 0.9)[0]?.pass).toBe(true);
    expect(scoreJury('rejected', 0.5)[0]?.pass).toBe(false);
  });
});

describe('the report', () => {
  const r = (id: string, pass: boolean): CaseResult => ({ id, bug: id, checks: [{ name: 'category', pass, detail: '' }], pass, ms: 1000, calls: 3, title: id });
  const meta = { at: 1, offline: false, models: { bulk: 'a', reasoning: 'b' }, prompt_version: 'p', threshold: 0.8 };

  it('counts passes per check and applies the bar', () => {
    const ok = summarize([r('a', true), r('b', true), r('c', true), r('d', true), r('e', false)], meta);
    expect(ok.pass_rate).toBe(0.8);
    expect(ok.checks.category).toEqual({ passed: 4, total: 5 });
    expect(ok.pass).toBe(true);
    expect(summarize([r('a', true), r('b', false)], meta).pass).toBe(false);
    expect(summarize([], meta).pass).toBe(false);
  });
});

describe('the golden set', () => {
  const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));

  it('has a case for the planted bugs and each is well formed', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const c = JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as GoldenCase;
      expect(c.id).toBe(f.replace('.json', ''));
      expect(BUGS.some((b) => b.bug === c.bug)).toBe(true);
      expect(c.evidence.length).toBeGreaterThan(2);
      expect(new Set(c.evidence.map((e) => e.id)).size).toBe(c.evidence.length);
      expect(c.expect.cause.length).toBeGreaterThan(0);
      expect(c.expect.where.length).toBeGreaterThan(0);
    }
  });

  it('is sensitive: an answer about the wrong bug fails every case', () => {
    const cases = loadCases(GOLDEN_DIR);
    const wrong = triage({ title: 'Cookie banner covers the footer', category: 'other', summary: claim('A banner covers the footer links.'), likely_cause: claim('A fixed-position banner.'), repro_steps: [{ step: 'Open any page.', evidence_ids: ['E1'] }, { step: 'Scroll down.', evidence_ids: ['E1'] }] });
    for (const c of cases) expect(scoreTriage(c, wrong).find((k) => k.name === 'names_the_defect')?.pass, c.bug).toBe(false);
  });
});
