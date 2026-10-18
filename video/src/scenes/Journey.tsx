import React from 'react';
import { interpolate } from 'remotion';
import { ACCENT, C, OUT } from '../theme';
import { Bg, Card, Eyebrow, Words, useSec } from '../ui';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** A title card between acts: the act number, its name, and one quiet line. */
export const ActCard: React.FC<{ index: string; title: string; line: string }> = ({ index, title, line }) => (
  <Bg variant="dark">
    <div style={{ position: 'absolute', left: 0, right: 0, top: 380, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Eyebrow text={`Act ${index}`} at={0.15} />
      <div style={{ marginTop: 26 }}>
        <Words text={title} at={0.35} size={104} align="center" />
      </div>
      <div style={{ marginTop: 22 }}>
        <Words text={line} at={1.1} size={34} weight={500} color={C.dim} align="center" stagger={0.035} />
      </div>
    </div>
  </Bg>
);

/** The shopping bag, drawn so its count can drop to zero. */
const BagIcon: React.FC<{ count: number; empty: number }> = ({ count, empty }) => (
  <div style={{ position: 'relative', width: 200, height: 200 }}>
    <svg width={200} height={200} viewBox="0 0 64 64">
      <path d="M14 22 H50 L47 56 H17 Z" fill="none" stroke={C.text} strokeWidth={2.6} strokeLinejoin="round" opacity={1 - 0.5 * empty} />
      <path d="M24 22 V18 a8 8 0 0 1 16 0 V22" fill="none" stroke={C.text} strokeWidth={2.6} strokeLinecap="round" opacity={1 - 0.5 * empty} />
    </svg>
    <div
      style={{
        position: 'absolute',
        right: 18,
        top: 30,
        width: 54,
        height: 54,
        borderRadius: 27,
        background: count > 0 ? ACCENT : 'rgba(255,255,255,.12)',
        color: '#fff',
        fontSize: 30,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${1 - 0.15 * empty})`,
      }}
    >
      {count}
    </div>
  </div>
);

const ROWS = [
  { k: 'Pair in the bag', v: 'Velocity Runner 4 · ₹10,795' },
  { k: 'Payment attempts', v: '2, both failed' },
  { k: 'Order', v: 'Not placed' },
];

/**
 * The shopper leaves: the bag empties, the session closes with no order, and the line says nobody finds out. Calm:
 * no shakes, no red alarms.
 */
export const Leave: React.FC = () => {
  const sec = useSec();
  const empty = interpolate(sec, [1.0, 2.0], [0, 1], { ...clamp, easing: OUT });
  const bagOut = interpolate(sec, [3.0, 3.6], [1, 0], clamp);
  const card = interpolate(sec, [3.2, 4.1], [0, 1], { ...clamp, easing: OUT });
  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', justifyContent: 'center', opacity: bagOut, transform: `translateY(${(1 - bagOut) * -20}px)` }}>
        <BagIcon count={empty > 0.5 ? 0 : 1} empty={empty} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 230, display: 'flex', justifyContent: 'center', opacity: card, transform: `translateY(${(1 - card) * 24}px)` }}>
        <Card dark at={3.2} style={{ width: 760, padding: '30px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ color: C.text, fontSize: 28, fontWeight: 600 }}>Session ended</div>
            <div style={{ padding: '6px 14px', borderRadius: 999, background: 'rgba(255,255,255,.08)', color: C.dim, fontSize: 17, fontWeight: 700, letterSpacing: 2 }}>ORDER NOT PLACED</div>
          </div>
          {ROWS.map((r, i) => {
            const o = interpolate(sec, [3.8 + i * 0.35, 4.3 + i * 0.35], [0, 1], { ...clamp, easing: OUT });
            return (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 0', borderTop: '1px solid rgba(255,255,255,.07)', marginTop: i === 0 ? 20 : 0, opacity: o }}>
                <span style={{ color: C.dim, fontSize: 24 }}>{r.k}</span>
                <span style={{ color: C.text, fontSize: 24, fontWeight: 500 }}>{r.v}</span>
              </div>
            );
          })}
        </Card>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 720, display: 'flex', justifyContent: 'center' }}>
        <Words text="They leave. *Nobody hears about it.*" at={5.6} size={64} align="center" />
      </div>
    </Bg>
  );
};
