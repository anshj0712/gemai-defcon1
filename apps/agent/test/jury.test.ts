import { describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import type { EvidenceItem } from '@cp/schema';
import { convene, gate, jurorsNeeded, summaryLine } from '../src/jury.js';
import { OfflineLlm } from '../src/llm/offline.js';
import type { ModelSet } from '../src/llm/models.js';

const params = { size: 4, threshold: 0.66 };
const ok = { agents_ok: true, visual_ok: true };

describe('the jury gate', () => {
  it('needs all jurors when fewer than four sit, and all but one when four sit', () => {
    expect(jurorsNeeded(4)).toBe(3);
    expect(jurorsNeeded(3)).toBe(3);
    expect(jurorsNeeded(1)).toBe(1);
  });

  it('approves only above the threshold (a mean of exactly 0.66 is held back)', () => {
    expect(gate({ scores: [0.7, 0.7, 0.7, 0.7], asked: 4, params, checks: ok }).outcome).toBe('approved');
    expect(gate({ scores: [0.66, 0.66, 0.66, 0.66], asked: 4, params, checks: ok }).outcome).toBe('rejected');
    expect(gate({ scores: [0.9, 0.9, 0.2, 0.2], asked: 4, params, checks: ok })).toMatchObject({ outcome: 'rejected', mean: 0.55 });
  });

  it('averages only the jurors who answered, and accepts three of four', () => {
    expect(gate({ scores: [0.9, 0.8, 0.7, null], asked: 4, params, checks: ok })).toMatchObject({ outcome: 'approved', mean: 0.8, answered: 3 });
  });

  it('gives no verdict when too few jurors answered', () => {
    expect(gate({ scores: [0.9, 0.9, null, null], asked: 4, params, checks: ok })).toMatchObject({ outcome: 'unavailable', mean: null, answered: 2 });
  });

  it('holds a report back when a code check failed, whatever the jurors said', () => {
    const bad = { agents_ok: true, visual_ok: false };
    const g = gate({ scores: [1, 1, 1, 1], asked: 4, params, checks: bad });
    expect(g.outcome).toBe('rejected');
    expect(summaryLine(g, params, bad)).toMatch(/screenshot/);
  });
});

describe('convening the jury', () => {
  const evidence: EvidenceItem[] = [
    { id: 'E1', kind: 'issue', text: 'Issue on /cart', data: { kind: 'element', route: '/cart', anchor: '#apply' } },
    { id: 'E2', kind: 'signal', text: 'dead click', data: { detector: 'dead_click' } },
    { id: 'E3', kind: 'impact', text: '40 sessions' },
  ];
  const m = new OfflineLlm();
  const models: ModelSet = { bulk: m, reasoning: m, offline: true };
  const report = { title: 't', tier: 'P1', affected_sessions: 40, revenue: { status: 'ok' as const, revenue_at_risk_minor: 100, currency: 'INR', note: null }, triage: null, root_cause: null, ranker: null };

  it('asks four jurors, writes a ruling, and labels the offline stand-in', async () => {
    const v = await convene({ models, params, logger: createLogger({ service: 'test', level: 'silent' }) }, { report, evidence, checks: ok, key: 'k' });
    expect(v.jurors).toHaveLength(4);
    expect(v.jurors.every((j) => j.ok && j.score !== null)).toBe(true);
    expect(v.offline).toBe(true);
    expect(v.ruling?.text).toMatch(/Offline stand-in/);
    expect(v.jurors_answered).toBe(4);
    expect(['approved', 'rejected']).toContain(v.outcome);
  });

  it('seats fewer jurors when JURY_SIZE is smaller', async () => {
    const v = await convene({ models, params: { size: 2, threshold: 0.5 }, logger: createLogger({ service: 'test', level: 'silent' }) }, { report, evidence, checks: ok, key: 'k' });
    expect(v.jurors.map((j) => j.role)).toEqual(['evidence_auditor', 'skeptic']);
  });
});
