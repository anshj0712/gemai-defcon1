import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { ACCENT, C, FONT, OUT } from './theme';

/** Seconds since the start of the current sequence. */
export const useSec = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps;
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Soft gradient backdrop that drifts slowly, like the reference. */
export const Bg: React.FC<{ variant: 'dark' | 'light'; children?: React.ReactNode }> = ({ variant, children }) => {
  const sec = useSec();
  const dx = Math.sin(sec * 0.25) * 6;
  const dy = Math.cos(sec * 0.2) * 5;
  const bg =
    variant === 'dark'
      ? `radial-gradient(900px 600px at ${18 + dx}% ${-5 + dy}%, rgba(124,58,237,.32), transparent 70%), radial-gradient(800px 520px at ${88 - dx}% ${0 + dy}%, rgba(255,122,89,.20), transparent 70%), radial-gradient(1000px 700px at 50% 110%, rgba(124,58,237,.12), transparent 70%), ${C.ink}`
      : `radial-gradient(900px 600px at ${80 + dx}% ${-10 + dy}%, rgba(255,186,160,.45), transparent 70%), radial-gradient(900px 640px at ${10 - dx}% ${0 + dy}%, rgba(196,170,255,.40), transparent 70%), ${C.pearl}`;
  return <AbsoluteFill style={{ background: bg, fontFamily: FONT }}>{children}</AbsoluteFill>;
};

/** Small spaced capitals above a headline. */
export const Eyebrow: React.FC<{ text: string; at?: number; dark?: boolean; index?: string }> = ({ text, at = 0, dark = true, index }) => {
  const sec = useSec();
  const t = sec - at;
  const o = interpolate(t, [0, 0.5], [0, 1], { ...clamp, easing: OUT });
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: 20, fontWeight: 600, letterSpacing: 4, textTransform: 'uppercase', opacity: o, transform: `translateY(${(1 - o) * 8}px)` }}>
      <span style={{ background: ACCENT, WebkitBackgroundClip: 'text', color: 'transparent' }}>{text}</span>
      {index && <span style={{ color: dark ? C.dim : C.dimDark, letterSpacing: 3 }}>{index}</span>}
    </div>
  );
};

/**
 * Text that arrives word by word: each word rises a few pixels out of a soft blur. Words wrapped in *stars* get the
 * gradient and, once the line has landed, an underline that draws itself.
 */
export const Words: React.FC<{ text: string; at?: number; size?: number; color?: string; weight?: number; stagger?: number; out?: number; lineHeight?: number; maxWidth?: number; align?: 'left' | 'center' }> = ({
  text,
  at = 0,
  size = 64,
  color = C.text,
  weight = 600,
  stagger = 0.055,
  out,
  lineHeight = 1.12,
  maxWidth,
  align = 'left',
}) => {
  const sec = useSec();
  // Runs of words: plain words, or one accent run (*like this*) that shares a single underline.
  const runs: { words: string[]; accent: boolean }[] = [];
  text.split(/(\*[^*]+\*)/).forEach((part) => {
    const accent = part.startsWith('*') && part.endsWith('*');
    const words = part.replace(/\*/g, '').split(' ').filter(Boolean);
    if (words.length) runs.push({ words, accent });
  });
  const total = runs.reduce((n, r) => n + r.words.length, 0);
  const landed = at + total * stagger + 0.45;
  const fadeOut = out === undefined ? 1 : interpolate(sec, [out, out + 0.45], [1, 0], clamp);
  const lift = out === undefined ? 0 : interpolate(sec, [out, out + 0.45], [0, -14], clamp);
  let idx = 0;
  // The gradient runs once across a whole accent phrase: each word takes its slice of it.
  const mix = (f: number) => {
    const A = [168, 85, 247];
    const B = [255, 122, 89];
    return `rgb(${A.map((v, k) => Math.round(v + (B[k]! - v) * f)).join(',')})`;
  };
  let slice: { from: number; to: number } | null = null;
  const word = (w: string, i: number, accent: boolean, last: boolean) => {
    const t = sec - (at + i * stagger);
    const p = interpolate(t, [0, 0.6], [0, 1], { ...clamp, easing: OUT });
    return (
      <span key={i} style={{ display: 'inline-block', marginRight: last ? 0 : size * 0.24, opacity: p, transform: `translateY(${(1 - p) * size * 0.4}px)`, filter: `blur(${(1 - p) * 10}px)` }}>
        <span style={accent && slice ? { background: `linear-gradient(90deg, ${mix(slice.from)}, ${mix(slice.to)})`, WebkitBackgroundClip: 'text', color: 'transparent' } : undefined}>{w}</span>
      </span>
    );
  };
  return (
    <div style={{ fontSize: size, fontWeight: weight, color, lineHeight, letterSpacing: -size * 0.025, maxWidth, textAlign: align, opacity: fadeOut, transform: `translateY(${lift}px)` }}>
      {runs.map((r, ri) => {
        const start = idx;
        idx += r.words.length;
        const chars = r.words.reduce((n, w) => n + w.length, 0);
        let seen = 0;
        const inner = r.words.map((w, wi) => {
          slice = r.accent ? { from: seen / chars, to: (seen + w.length) / chars } : null;
          seen += w.length;
          return word(w, start + wi, r.accent, r.accent && wi === r.words.length - 1);
        });
        if (!r.accent) return <React.Fragment key={ri}>{inner}</React.Fragment>;
        const under = interpolate(sec - landed, [0, 0.6], [0, 1], { ...clamp, easing: OUT });
        return (
          <span key={ri} style={{ display: 'inline-block', position: 'relative', marginRight: size * 0.24, whiteSpace: 'nowrap' }}>
            {inner}
            <span style={{ position: 'absolute', left: 0, right: 0, bottom: -size * 0.06, height: Math.max(3, size * 0.045), borderRadius: 4, background: ACCENT, transform: `scaleX(${under})`, transformOrigin: 'left' }} />
          </span>
        );
      })}
    </div>
  );
};

/** A floating card: white, rounded, with a soft violet-tinted shadow. */
export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; at?: number; dark?: boolean }> = ({ children, style, at = 0, dark = false }) => {
  const sec = useSec();
  const p = interpolate(sec - at, [0, 0.8], [0, 1], { ...clamp, easing: OUT });
  const float = Math.sin(sec * 0.9) * 4;
  return (
    <div
      style={{
        borderRadius: 28,
        background: dark ? 'rgba(24,20,36,.82)' : '#ffffff',
        border: dark ? '1px solid rgba(255,255,255,.08)' : '1px solid rgba(255,255,255,.7)',
        boxShadow: dark ? '0 40px 120px rgba(0,0,0,.55)' : '0 50px 120px rgba(60,30,110,.18), 0 10px 30px rgba(60,30,110,.08)',
        opacity: p,
        transform: `translateY(${(1 - p) * 40 + float}px) scale(${0.97 + 0.03 * p})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** A big number that counts up, in the gradient, with a drawn underline. */
export const Stat: React.FC<{ to: number; at?: number; decimals?: number; prefix?: string; suffix?: string; size?: number; label?: string; dark?: boolean }> = ({ to, at = 0, decimals = 0, prefix = '', suffix = '', size = 180, label, dark = true }) => {
  const sec = useSec();
  const t = sec - at;
  const p = interpolate(t, [0, 1.4], [0, 1], { ...clamp, easing: OUT });
  const o = interpolate(t, [0, 0.4], [0, 1], clamp);
  const u = interpolate(t, [1.0, 1.6], [0, 1], { ...clamp, easing: OUT });
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', opacity: o }}>
      {label && <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 4, textTransform: 'uppercase', color: dark ? C.dim : C.dimDark, marginBottom: 14 }}>{label}</div>}
      <div style={{ fontSize: size, fontWeight: 700, letterSpacing: -size * 0.04, lineHeight: 1, background: ACCENT, WebkitBackgroundClip: 'text', color: 'transparent', fontVariantNumeric: 'tabular-nums' }}>
        {prefix}
        {(to * p).toFixed(decimals)}
        {suffix}
      </div>
      <div style={{ height: 6, width: '100%', marginTop: 14, borderRadius: 4, background: ACCENT, transform: `scaleX(${u})`, transformOrigin: 'left' }} />
    </div>
  );
};

/** Scene transition: the incoming scene sharpens out of a blur over the outgoing one. */
export const FadeIn: React.FC<{ children: React.ReactNode; frames: number }> = ({ children, frames }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, frames], [0, 1], { ...clamp, easing: OUT });
  return <AbsoluteFill style={{ opacity: p, filter: p < 1 ? `blur(${(1 - p) * 14}px)` : undefined, transform: `scale(${1.02 - 0.02 * p})` }}>{children}</AbsoluteFill>;
};

/** A spinner that turns into a tick. */
export const Tick: React.FC<{ done: number; size?: number }> = ({ done, size = 34 }) => {
  const sec = useSec();
  if (done <= 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 34 34">
        <circle cx={17} cy={17} r={13} fill="none" stroke="rgba(255,255,255,.15)" strokeWidth={3} />
        <circle cx={17} cy={17} r={13} fill="none" stroke="#a855f7" strokeWidth={3} strokeDasharray="20 62" strokeLinecap="round" transform={`rotate(${sec * 400} 17 17)`} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 34 34">
      <circle cx={17} cy={17} r={15} fill="url(#g)" opacity={Math.min(1, done * 2)} />
      <defs>
        <linearGradient id="g" x1="0" x2="1">
          <stop offset="0" stopColor="#a855f7" />
          <stop offset="1" stopColor="#ff7a59" />
        </linearGradient>
      </defs>
      <path d="M10 17.5 L15 22.5 L24 12.5" fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={22} strokeDashoffset={22 * (1 - Math.min(1, done))} />
    </svg>
  );
};
