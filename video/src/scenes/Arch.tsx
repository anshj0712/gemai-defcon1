import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, OUT } from '../theme';
import { Bg, Eyebrow, Words } from '../ui';

interface NodeDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  tone: 'plain' | 'gemini' | 'merchant' | 'store';
  at: number; // seconds
}

const TONE = {
  plain: { bg: C.panel, border: C.line, title: C.text },
  gemini: { bg: C.blueSoft, border: C.blue, title: '#cfe0ff' },
  merchant: { bg: '#4b2a14', border: C.amber, title: '#ffe2b8' },
  store: { bg: '#10172e', border: C.line, title: C.text },
} as const;

const NW = 262;
const NH = 200;
const GAP = 44;
const X0 = (1920 - (6 * NW + 5 * GAP)) / 2;
const row1 = (i: number) => X0 + i * (NW + GAP);

const NODES: NodeDef[] = [
  { id: 'browser', x: row1(0), y: 230, w: NW, h: NH, title: "Shopper's browser", lines: ['One script tag', 'rrweb, inputs masked'], tone: 'plain', at: 1.0 },
  { id: 'ingest', x: row1(1), y: 230, w: NW, h: NH, title: 'Ingest', lines: ['Collector scrubs', 'Pub/Sub keeps order'], tone: 'plain', at: 3.4 },
  { id: 'detect', x: row1(2), y: 230, w: NW, h: NH, title: 'Detect', lines: ['Five detectors', 'turn sessions into', 'signals'], tone: 'plain', at: 6.2 },
  { id: 'group', x: row1(3), y: 230, w: NW, h: NH, title: 'Group', lines: ['Clusterer: one', 'issue per bug'], tone: 'plain', at: 8.6 },
  { id: 'explain', x: row1(4), y: 230, w: NW, h: NH, title: 'Explain and rank', lines: ['Gemini on Vertex AI', 'code scores the ₹'], tone: 'gemini', at: 11.0 },
  { id: 'merchant', x: row1(5), y: 230, w: NW, h: NH, title: 'Merchant', lines: ['Ranked findings,', 'replay, approvals'], tone: 'merchant', at: 13.6 },
];
const STORES: NodeDef[] = [
  { id: 's1', x: row1(0), y: 780, w: 3 * NW + 2 * GAP - 0, h: 150, title: 'Raw sessions · Cloud Storage', lines: ['Written once, never changed', 'so any past day can be replayed'], tone: 'store', at: 16.2 },
  { id: 's2', x: row1(3), y: 780, w: 2 * NW + GAP, h: 150, title: 'The record · BigQuery', lines: ['Append-only; valid time +', 'transaction time on every row'], tone: 'store', at: 17.4 },
  { id: 's3', x: row1(5), y: 780, w: NW, h: 150, title: 'Hot state · Firestore', lines: ['Live issues, rules'], tone: 'store', at: 18.6 },
];

const NodeBox: React.FC<{ n: NodeDef; pulse?: number }> = ({ n, pulse = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - n.at;
  if (t < 0) return null;
  const s = spring({ frame: t * fps, fps, config: { damping: 13, stiffness: 150 } });
  const tone = TONE[n.tone];
  return (
    <div
      style={{
        position: 'absolute',
        left: n.x,
        top: n.y,
        width: n.w,
        height: n.h,
        borderRadius: 22,
        background: tone.bg,
        border: `3px solid ${tone.border}`,
        boxShadow: pulse > 0 ? `0 0 ${40 * pulse}px ${tone.border}` : '0 18px 50px rgba(0,0,0,.4)',
        transform: `scale(${0.6 + 0.4 * s}) translateY(${(1 - s) * 30}px)`,
        opacity: Math.min(1, s * 1.4),
        padding: '22px 24px',
        fontFamily: FONT,
        color: C.text,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700, color: tone.title, letterSpacing: -0.3 }}>{n.title}</div>
      <div style={{ marginTop: 10, fontSize: 23, color: C.dim, lineHeight: 1.3 }}>
        {n.lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
    </div>
  );
};

/** A dot that travels along a straight arrow, over and over. */
const Packet: React.FC<{ x1: number; x2: number; y: number; start: number; color: string; period?: number }> = ({ x1, x2, y, start, color, period = 1.3 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - start;
  if (t < 0) return null;
  const p = (t % period) / period;
  const x = x1 + (x2 - x1) * p;
  const a = Math.sin(p * Math.PI);
  return <div style={{ position: 'absolute', left: x - 9, top: y - 9, width: 18, height: 18, borderRadius: '50%', background: color, boxShadow: `0 0 22px ${color}`, opacity: a }} />;
};

const Arrow: React.FC<{ x1: number; x2: number; y: number; at: number }> = ({ x1, x2, y, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - at;
  if (t < 0) return null;
  const p = interpolate(t, [0, 0.6], [0, 1], { easing: OUT, extrapolateRight: 'clamp' });
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0 }} width={1920} height={1080}>
      <line x1={x1} y1={y} x2={x1 + (x2 - x1) * p} y2={y} stroke={C.dim} strokeWidth={4} strokeLinecap="round" />
      {p > 0.95 && <polygon points={`${x2},${y} ${x2 - 14},${y - 9} ${x2 - 14},${y + 9}`} fill={C.dim} />}
    </svg>
  );
};

export const Arch: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const geminiPulse = sec > 11 ? 0.5 + 0.5 * Math.sin((sec - 11) * 4) : 0;
  const title = spring({ frame, fps, config: { damping: 18 } });

  // The funnel: only issues reach Gemini.
  const fun = interpolate(sec, [14.4, 16.2], [0, 1], { easing: OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const count = (to: number) => Math.round(to * fun);

  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', left: X0, top: 70, opacity: title }}>
        <Eyebrow text="Under the hood" index="06 / 06" />
        <div style={{ marginTop: 12 }}>
          <Words text="Only issues reach *Gemini.*" at={0.3} size={56} />
        </div>
      </div>

      {NODES.slice(0, -1).map((n, i) => (
        <Arrow key={n.id} x1={n.x + n.w + 6} x2={NODES[i + 1]!.x - 6} y={n.y + n.h / 2} at={NODES[i + 1]!.at - 0.5} />
      ))}
      {NODES.slice(0, -1).map((n, i) => (
        <Packet key={`p-${n.id}`} x1={n.x + n.w + 6} x2={NODES[i + 1]!.x - 6} y={n.y + n.h / 2} start={NODES[i + 1]!.at + 0.2} color={i >= 3 ? C.blue : C.green} />
      ))}
      {NODES.map((n) => (
        <NodeBox key={n.id} n={n} pulse={n.id === 'explain' ? geminiPulse : 0} />
      ))}

      {/* detector chips under Detect */}
      <div style={{ position: 'absolute', left: NODES[2]!.x - 40, top: 450, width: NW + 120, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
        {['rage click', 'dead click', 'slow', 'wrong number', 'error'].map((d, i) => {
          const t = sec - (6.8 + i * 0.28);
          const s = t < 0 ? 0 : spring({ frame: t * fps, fps, config: { damping: 14, stiffness: 170 } });
          return (
            <div key={d} style={{ padding: '8px 16px', borderRadius: 999, background: C.panel, border: `2px solid ${C.green}`, color: C.text, fontSize: 21, fontWeight: 600, opacity: s, transform: `scale(${0.7 + 0.3 * s})`, whiteSpace: 'nowrap' }}>
              {d}
            </div>
          );
        })}
      </div>

      {/* the funnel */}
      <div style={{ position: 'absolute', left: row1(0), top: 530, width: 3 * NW + 2 * GAP, fontSize: 26, color: C.dim, opacity: fun }}>
        <div style={{ fontWeight: 700, color: C.text, marginBottom: 14, fontSize: 28 }}>Only issues reach Gemini</div>
        {[
          { label: 'Sessions', value: count(240), w: 1, color: C.dim },
          { label: 'Issues', value: count(11), w: 0.14, color: C.blue },
          { label: 'Gemini reports', value: count(11), w: 0.14, color: C.violet },
        ].map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 12 }}>
            <div style={{ width: 190 }}>{r.label}</div>
            <div style={{ height: 22, width: 560 * r.w * fun, background: r.color, borderRadius: 11, minWidth: 14 }} />
            <div style={{ color: C.text, fontWeight: 700, fontSize: 30 }}>{r.value}</div>
          </div>
        ))}
      </div>

      {STORES.map((n) => (
        <NodeBox key={n.id} n={n} />
      ))}
      {/* write lines from the pipeline into storage */}
      {sec > 16.4 &&
        [0, 1, 2].map((i) => {
          const xs = [row1(1) + NW / 2, row1(3) + NW, row1(5) + NW / 2][i]!;
          const p = ((sec - 16.4 + i * 0.4) % 1.4) / 1.4;
          return <div key={i} style={{ position: 'absolute', left: xs - 8, top: 430 + (770 - 430) * p, width: 16, height: 16, borderRadius: '50%', background: C.amber, boxShadow: `0 0 20px ${C.amber}`, opacity: Math.sin(p * Math.PI) }} />;
        })}
    </Bg>
  );
};
