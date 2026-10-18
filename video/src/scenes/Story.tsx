import React from 'react';
import { interpolate } from 'remotion';
import data from '../../public/data.json';
import { ACCENT, C, lakh, OUT } from '../theme';
import { Bg, Card, Eyebrow, Stat, Tick, Words, useSec } from '../ui';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Opening: three short lines, the last in the gradient with an underline. */
export const Intro: React.FC = () => (
  <Bg variant="dark">
    <div style={{ position: 'absolute', left: 230, top: 330 }}>
      <Eyebrow text="Churn Preventer Agent" index="Retail & Commerce" at={0.2} />
      <div style={{ marginTop: 34, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Words text="Find the bug." at={0.6} size={112} />
        <Words text="Rank the loss." at={1.4} size={112} />
        <Words text="*Check the past.*" at={2.2} size={112} />
      </div>
    </div>
  </Bg>
);

const DRIFT = [
  { w: 'Payment failed', x: 260, y: 230, d: 0.9, z: 0.7 },
  { w: 'Dead button', x: 1420, y: 210, d: 1.4, z: 0.55 },
  { w: 'Wrong cart total', x: 1180, y: 820, d: 0.5, z: 0.8 },
  { w: 'Hidden ₹499 fee', x: 330, y: 790, d: 1.8, z: 0.6 },
  { w: 'Slow bank', x: 1560, y: 520, d: 1.1, z: 0.5 },
  { w: '500 at checkout', x: 160, y: 520, d: 2.1, z: 0.65 },
];

/** The problem: the bugs drift in the background, out of focus, while the line says why nobody hears about them. */
export const Problem: React.FC = () => {
  const sec = useSec();
  return (
    <Bg variant="dark">
      {DRIFT.map((d) => {
        const o = interpolate(sec, [d.d, d.d + 1.2], [0, 0.55 * d.z], clamp);
        const x = d.x + Math.sin(sec * 0.3 + d.d) * 30;
        const y = d.y + Math.cos(sec * 0.25 + d.d) * 18 - sec * 6;
        return (
          <div key={d.w} style={{ position: 'absolute', left: x, top: y, padding: '12px 24px', borderRadius: 999, border: '1px solid rgba(255,255,255,.18)', color: C.text, fontSize: 30 * d.z + 6, fontWeight: 500, opacity: o, filter: `blur(${(1 - d.z) * 7}px)`, whiteSpace: 'nowrap' }}>
            {d.w}
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 440, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Eyebrow text="The problem" at={0.2} />
        <div style={{ marginTop: 26, position: 'relative', height: 200, width: 1500 }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center' }}>
            <Words text="Checkout bugs rarely get *reported.*" at={0.5} size={76} align="center" out={4.4} />
          </div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center' }}>
            <Words text="Analytics show the drop. *Not the cause.*" at={5.0} size={76} align="center" />
          </div>
        </div>
      </div>
    </Bg>
  );
};

const STEPS = [
  { at: 1.0, done: 2.0, text: 'Reading shopper sessions', meta: 'rrweb, inputs masked' },
  { at: 2.0, done: 3.0, text: 'Spotting failed payments', meta: 'error after a click' },
  { at: 3.0, done: 4.0, text: 'Grouping them into one issue', meta: `${data.top[0]!.shoppers} shoppers` },
  { at: 4.0, done: 5.4, text: 'Gemini explains the cause', meta: 'Vertex AI' },
  { at: 5.4, done: 6.6, text: 'Four AI jurors check the report', meta: 'code decides' },
];

/** The agent at work, as a live checklist, then the issue it produced. */
export const AgentRun: React.FC = () => {
  const sec = useSec();
  const top = data.top[0]!;
  const card = interpolate(sec, [6.8, 7.7], [0, 1], { ...clamp, easing: OUT });
  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', left: 230, top: 120 }}>
        <Eyebrow text="Detect" index="02 / 06" at={0.1} />
        <div style={{ marginTop: 16 }}>
          <Words text="It catches the failure *on its own.*" at={0.3} size={60} />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 230, top: 330 }}>
        <Card dark at={0.4} style={{ width: 760, padding: '30px 34px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: C.text, fontSize: 24, fontWeight: 600 }}>
              <span style={{ width: 12, height: 12, borderRadius: 6, background: ACCENT }} />
              Churn Preventer agent
            </div>
            <div style={{ padding: '6px 14px', borderRadius: 999, background: 'rgba(168,85,247,.16)', color: '#d8b4fe', fontSize: 16, fontWeight: 700, letterSpacing: 2 }}>{sec < 6.6 ? 'RUNNING' : 'DONE'}</div>
          </div>
          {STEPS.map((s) => {
            const o = interpolate(sec, [s.at, s.at + 0.45], [0, 1], { ...clamp, easing: OUT });
            const done = interpolate(sec, [s.done, s.done + 0.4], [0, 1], clamp);
            return (
              <div key={s.text} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '13px 0', opacity: o, transform: `translateY(${(1 - o) * 10}px)`, borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <Tick done={sec >= s.done ? done : 0} />
                <div style={{ flex: 1, color: C.text, fontSize: 26, fontWeight: 500 }}>{s.text}</div>
                <div style={{ color: C.dim, fontSize: 19 }}>{s.meta}</div>
              </div>
            );
          })}
        </Card>
      </div>
      <div style={{ position: 'absolute', left: 1080, top: 390, opacity: card, transform: `translateX(${(1 - card) * 60}px)` }}>
        <Card style={{ width: 620, padding: '34px 38px' }} at={6.8}>
          <div style={{ display: 'flex', gap: 10 }}>
            <span style={{ padding: '6px 14px', borderRadius: 8, background: '#fde8e8', color: '#c0262d', fontSize: 18, fontWeight: 700 }}>P0 · urgent</span>
            <span style={{ padding: '6px 14px', borderRadius: 8, background: '#f1eef8', color: C.dimDark, fontSize: 18, fontWeight: 600 }}>Checkout blocker</span>
          </div>
          <div style={{ marginTop: 18, fontSize: 34, fontWeight: 700, color: C.dark, letterSpacing: -0.8, lineHeight: 1.15 }}>{top.title}</div>
          <div style={{ marginTop: 10, fontSize: 21, color: C.dimDark }}>{top.shoppers} shoppers · seen live on the checkout page</div>
          <div style={{ marginTop: 26, fontSize: 18, fontWeight: 600, letterSpacing: 3, color: C.dimDark, textTransform: 'uppercase' }}>Revenue lost so far</div>
          <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2, background: ACCENT, WebkitBackgroundClip: 'text', color: 'transparent' }}>₹{lakh(top.minor * Math.min(1, card * 1.1))}L</div>
        </Card>
      </div>
    </Bg>
  );
};

const ROWS = [
  { name: 'Rage and dead clicks', a: true },
  { name: 'Silent wrong totals and fees', a: false },
  { name: 'Ranked by rupees lost', a: false },
  { name: 'A new rule re-checks the past', a: false },
  { name: 'AI report reviewed by jurors', a: false },
];

/** Results: the measured numbers count up, then how it compares. */
export const Results: React.FC = () => {
  const sec = useSec();
  const tableIn = interpolate(sec, [8.6, 9.4], [0, 1], { ...clamp, easing: OUT });
  const statsOut = interpolate(sec, [8.2, 8.8], [1, 0], clamp);
  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', left: 0, right: 0, top: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: statsOut }}>
        <Eyebrow text="Results" index="240 simulated shoppers · 13 planted bugs" at={0.1} />
        <div style={{ marginTop: 60 }}>
          <Stat to={8} at={0.5} suffix=" of 8" size={190} label="Loud bugs found, one issue each" />
        </div>
        <div style={{ marginTop: 80, display: 'flex', gap: 120 }}>
          <Stat to={0} at={2.6} size={86} label="False alarms" />
          <Stat to={27.6} at={3.4} decimals={1} suffix=" s" size={86} label="Action to flag" />
          <Stat to={11} at={4.2} suffix=" / 11" size={86} label="Agent eval cases" />
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: tableIn }}>
        <Eyebrow text="What is new" at={8.6} />
        <Card dark at={8.8} style={{ marginTop: 34, width: 1180, padding: '30px 44px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px 260px', alignItems: 'end', paddingBottom: 18, borderBottom: '1px solid rgba(255,255,255,.08)' }}>
            <div style={{ fontSize: 18, letterSpacing: 3, color: C.dim, textTransform: 'uppercase', fontWeight: 600 }}>Capability</div>
            <div style={{ textAlign: 'center', color: C.dim, fontSize: 24, fontWeight: 600 }}>Replay tools</div>
            <div style={{ textAlign: 'center', fontSize: 26, fontWeight: 700, background: ACCENT, WebkitBackgroundClip: 'text', color: 'transparent' }}>Churn Preventer</div>
          </div>
          {ROWS.map((r, i) => {
            const t = sec - (9.4 + i * 0.45);
            const o = interpolate(t, [0, 0.45], [0, 1], { ...clamp, easing: OUT });
            const tick = interpolate(t, [0.25, 0.7], [0, 1], clamp);
            return (
              <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1fr 220px 260px', alignItems: 'center', padding: '20px 0', borderBottom: i < ROWS.length - 1 ? '1px solid rgba(255,255,255,.06)' : undefined, opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
                <div style={{ color: C.text, fontSize: 30, fontWeight: 500 }}>{r.name}</div>
                <div style={{ textAlign: 'center', color: r.a ? C.text : 'rgba(255,255,255,.25)', fontSize: 30 }}>{r.a ? '✓' : '—'}</div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Tick done={tick} size={38} />
                </div>
              </div>
            );
          })}
        </Card>
      </div>
    </Bg>
  );
};

/** The close: the mark, the line, the live link. */
export const Cta: React.FC = () => {
  const sec = useSec();
  const a = interpolate(sec, [0.1, 0.9], [0, 1], { ...clamp, easing: OUT });
  const b = interpolate(sec, [1.6, 2.3], [0, 1], { ...clamp, easing: OUT });
  return (
    <Bg variant="dark">
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 120, height: 120, borderRadius: 32, background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: a, transform: `scale(${0.8 + 0.2 * a})`, boxShadow: '0 30px 80px rgba(168,85,247,.45)' }}>
          <svg width={70} height={70} viewBox="0 0 28 28">
            <path d="M5 9 L11 16 L15 12 L23 21" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={11} cy={16} r={2.2} fill="#fff" />
          </svg>
        </div>
        <div style={{ marginTop: 48 }}>
          <Words text="Find the bug before the *shopper leaves.*" at={0.6} size={76} align="center" />
        </div>
        <div style={{ marginTop: 50, opacity: b, transform: `translateY(${(1 - b) * 14}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
          <div style={{ padding: '18px 40px', borderRadius: 999, background: ACCENT, color: '#fff', fontSize: 28, fontWeight: 700 }}>Open the live demo</div>
          <div style={{ color: C.dim, fontSize: 24 }}>cp-api-w46tbwzpaq-el.a.run.app · built on Google Cloud with Gemini · demo data is synthetic</div>
        </div>
      </div>
    </Bg>
  );
};
