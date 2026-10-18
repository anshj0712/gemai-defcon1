import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, INOUT, OUT } from '../theme';
import { Bg, Eyebrow, Words } from '../ui';

const COLS = 30; // days
const ROWS = 9; // 30 x 9 = 270 slots, 249 are sessions
const SESSIONS = 249;
const HITS = 12;

/** Same layout every frame: which slots are sessions, and which ones the rule catches (spread over the last two weeks). */
function layout() {
  const slots: { c: number; r: number; hit: boolean }[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const all = Array.from({ length: COLS * ROWS }, (_, i) => ({ c: i % COLS, r: Math.floor(i / COLS) }));
  const keep = all.slice(0, SESSIONS + 21).filter(() => true);
  // drop 21 random slots so it is exactly 249 sessions
  const drop = new Set<number>();
  while (drop.size < keep.length - SESSIONS) drop.add(Math.floor(rnd() * keep.length));
  const sessions = keep.filter((_, i) => !drop.has(i));
  const late = sessions.map((s, i) => ({ s, i })).filter(({ s }) => s.c >= 12);
  const hit = new Set<number>();
  while (hit.size < HITS) hit.add(late[Math.floor(rnd() * late.length)]!.i);
  sessions.forEach((s, i) => slots.push({ ...s, hit: hit.has(i) }));
  return slots;
}
const SLOTS = layout();

export const Rescan: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const sec = frame / fps;
  const total = durationInFrames / fps;
  const head = spring({ frame, fps, config: { damping: 18 } });
  const scanStart = 1.2;
  const scanEnd = total - 1.8;
  const p = interpolate(sec, [scanStart, scanEnd], [0, 1], { easing: INOUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const x0 = 140;
  const cell = 52;
  const gx = (c: number) => x0 + c * cell;
  const gy = (r: number) => 330 + r * cell;
  const scanX = x0 + p * (COLS * cell);
  const scanned = SLOTS.filter((s) => gx(s.c) + cell / 2 <= scanX).length;
  const found = SLOTS.filter((s) => s.hit && gx(s.c) + cell / 2 <= scanX).length;
  const ruleIn = spring({ frame: (sec - 0.2) * fps, fps, config: { damping: 14, stiffness: 150 } });
  const done = p >= 1;

  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', left: 140, top: 64, opacity: head }}>
        <Eyebrow text="The merchant" index="02 / 03" />
        <div style={{ marginTop: 12 }}>
          <Words text="Approve a rule. It re-checks *30 days.*" at={0.2} size={54} />
        </div>
      </div>

      <div style={{ position: 'absolute', left: 140, top: 215, padding: '14px 28px', borderRadius: 16, background: C.panel, border: `2px solid ${C.violet}`, color: C.text, fontSize: 30, fontWeight: 600, opacity: ruleIn, transform: `translateX(${(1 - ruleIn) * -80}px)` }}>
        <span style={{ color: C.violet, fontWeight: 800 }}>Rule </span>payment authorization must take at most 3,400 ms
      </div>

      {SLOTS.map((s, i) => {
        const x = gx(s.c) + cell / 2;
        const passed = x <= scanX;
        const dx = scanX - x;
        const flash = s.hit && passed ? Math.max(0, 1 - dx / 160) : 0;
        const color = s.hit && passed ? C.red : passed ? '#5b6b9a' : '#2c365a';
        const size = s.hit && passed ? 26 + 16 * flash : 24;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: gx(s.c) + cell / 2 - size / 2,
              top: gy(s.r) + cell / 2 - size / 2,
              width: size,
              height: size,
              borderRadius: '50%',
              background: color,
              boxShadow: s.hit && passed ? `0 0 ${24 + 40 * flash}px ${C.red}` : 'none',
            }}
          />
        );
      })}

      {/* the scanner */}
      {p > 0 && p < 1 && <div style={{ position: 'absolute', left: scanX - 3, top: 300, width: 6, height: ROWS * cell + 40, background: `linear-gradient(${C.blue}, ${C.violet})`, boxShadow: `0 0 40px ${C.blue}`, borderRadius: 3 }} />}
      <div style={{ position: 'absolute', left: x0, top: 330 + ROWS * cell + 12, width: COLS * cell, display: 'flex', justifyContent: 'space-between', color: C.dim, fontSize: 24 }}>
        <span>30 days ago</span>
        <span>today</span>
      </div>

      {/* counters */}
      <div style={{ position: 'absolute', left: 140, top: 900, display: 'flex', gap: 70, alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 24, color: C.dim }}>Sessions checked</div>
          <div style={{ fontSize: 86, fontWeight: 800, color: C.text, letterSpacing: -2 }}>{scanned}</div>
        </div>
        <div>
          <div style={{ fontSize: 24, color: C.dim }}>Past shoppers found</div>
          <div style={{ fontSize: 86, fontWeight: 800, color: C.red, letterSpacing: -2 }}>{found}</div>
        </div>
        {done && (
          <div style={{ fontSize: 40, fontWeight: 700, color: C.green, opacity: interpolate(sec, [scanEnd, scanEnd + 0.4], [0, 1], { extrapolateRight: 'clamp', easing: OUT }) }}>in about 10 seconds</div>
        )}
      </div>
    </Bg>
  );
};
