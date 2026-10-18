import { Video } from '@remotion/media';
import React from 'react';
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FPS, OUT } from './theme';
import { Bg, Card, Eyebrow, Words, useSec } from './ui';

export interface FocusEvent {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  hold: number;
  click: boolean;
  label?: string;
}
export interface ClipMeta {
  id: string;
  trim: number;
  duration: number;
  width: number;
  height: number;
  events: FocusEvent[];
}

const IN_LEAD = 0.3;
const OUT_TAIL = 0.6;

interface Key {
  t: number;
  k: number;
  px: number;
  py: number;
}

/** The camera as keyframes: glide in to each element the presenter touches, hold, glide back (or straight on to the next). */
export function cameraKeys(events: FocusEvent[], trim: number, cx: number, cy: number): Key[] {
  const ev = events
    .map((e) => ({ ...e, t: e.t - trim }))
    .filter((e) => e.t >= -0.2)
    .sort((a, b) => a.t - b.t);
  const keys: Key[] = [{ t: -1, k: 1, px: cx, py: cy }];
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i]!;
    const last = keys[keys.length - 1]!;
    const a = Math.max(last.t + 0.04, e.t - IN_LEAD);
    keys.push({ t: a, k: last.k, px: last.px, py: last.py });
    const sc = Math.max(1.12, Math.min(e.scale * 0.85, (0.8 * cx * 2) / Math.max(e.w, 1), (0.8 * cy * 2) / Math.max(e.h, 1)));
    keys.push({ t: a + 0.55, k: sc, px: e.x, py: e.y });
    const b = Math.max(a + 0.7, e.t + e.hold);
    keys.push({ t: b, k: sc, px: e.x, py: e.y });
    const next = ev[i + 1];
    if (!next || next.t - IN_LEAD > b + OUT_TAIL + 0.3) keys.push({ t: b + OUT_TAIL, k: 1, px: cx, py: cy });
  }
  for (let i = 1; i < keys.length; i++) if (keys[i]!.t <= keys[i - 1]!.t) keys[i]!.t = keys[i - 1]!.t + 0.02;
  return keys;
}

/** The recording inside a card, with a camera that eases toward whatever is touched, and a soft ring and ripple there. */
export const Screen: React.FC<{ clip: ClipMeta; id: string; rate: number; width: number; height: number }> = ({ clip, id, rate, width, height }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tv = (frame / fps) * rate;
  const s = width / clip.width;
  const keys = cameraKeys(clip.events, clip.trim, clip.width / 2, clip.height / 2);
  const times = keys.map((k) => k.t);
  const ease = Easing.bezier(0.33, 0, 0.15, 1);
  const opt = { easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
  const k = interpolate(tv, times, keys.map((x) => x.k), opt);
  const px = interpolate(tv, times, keys.map((x) => x.px), opt) * s;
  const py = interpolate(tv, times, keys.map((x) => x.py), opt) * s;
  const qx = px + (width / 2 - px) * 0.35;
  const qy = py + (height / 2 - py) * 0.35;
  const tx = Math.min(0, Math.max(width * (1 - k), qx - k * px));
  const ty = Math.min(0, Math.max(height * (1 - k), qy - k * py));
  const events = clip.events.map((e) => ({ ...e, t: e.t - clip.trim })).filter((e) => e.t >= -0.2);

  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden', borderRadius: 20 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, height, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${k})` }}>
        <Video src={staticFile(`clips/${id}.mp4`)} trimBefore={Math.round(clip.trim * FPS)} playbackRate={rate} muted style={{ width, height, objectFit: 'cover' }} />
        {events.map((e, i) => {
          const local = tv - (e.t - IN_LEAD);
          const life = e.hold + IN_LEAD + 0.5;
          if (local < 0 || local > life) return null;
          const fade = interpolate(local, [0, 0.35, life - 0.5, life], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const grow = interpolate(local, [0, 0.5], [1.12, 1], { easing: OUT, extrapolateRight: 'clamp' });
          const pad = 8;
          const clickAt = tv - e.t;
          const ring = e.click && clickAt > 0 && clickAt < 0.8 ? clickAt / 0.8 : -1;
          return (
            <React.Fragment key={i}>
              <div
                style={{
                  position: 'absolute',
                  left: (e.x - e.w / 2) * s - pad,
                  top: (e.y - e.h / 2) * s - pad,
                  width: e.w * s + pad * 2,
                  height: e.h * s + pad * 2,
                  borderRadius: 12,
                  border: `${2 / k}px solid rgba(168,85,247,.85)`,
                  boxShadow: `0 0 ${24 / k}px rgba(168,85,247,.45)`,
                  opacity: fade,
                  transform: `scale(${grow})`,
                }}
              />
              {ring >= 0 && <div style={{ position: 'absolute', left: e.x * s - 40, top: e.y * s - 40, width: 80, height: 80, borderRadius: '50%', border: '3px solid rgba(168,85,247,.9)', opacity: (1 - ring) * 0.9, transform: `scale(${0.35 + ring * 1.1})` }} />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export interface Beat {
  /** Seconds into the scene. */
  t: number;
  text: string;
}

/**
 * A screen scene in the reference's style: pearl backdrop, an eyebrow and a short line on top that changes with the
 * story (each line rises in word by word; the old one drifts up and fades), and the recording in a floating card.
 */
export const ScreenScene: React.FC<{ clip: ClipMeta; id: string; secs: number; eyebrow: string; index: string; beats: Beat[]; aside?: React.ReactNode }> = ({ clip, id, secs, eyebrow, index, beats, aside }) => {
  const sec = useSec();
  const rate = Math.max(0.7, Math.min(1.8, (clip.duration - clip.trim - 0.2) / secs));
  const cw = 1460;
  const ch = Math.round((cw * clip.height) / clip.width);
  return (
    <Bg variant="light">
      <div style={{ position: 'absolute', left: 230, top: 66 }}>
        <Eyebrow text={eyebrow} index={index} dark={false} />
        <div style={{ position: 'relative', height: 80, marginTop: 14, width: 1500 }}>
          {beats.map((b, i) => {
            const next = beats[i + 1];
            if (sec < b.t - 0.05 || (next && sec > next.t + 0.6)) return null;
            return (
              <div key={i} style={{ position: 'absolute', left: 0, top: 0 }}>
                <Words text={b.text} at={b.t} size={52} color={C.dark} out={next ? next.t - 0.1 : undefined} />
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: (1920 - cw) / 2, top: 215 }}>
        <Card at={0.1} style={{ padding: 10, borderRadius: 30 }}>
          <Screen clip={clip} id={id} rate={rate} width={cw - 20} height={ch - 12} />
        </Card>
      </div>
      {aside}
    </Bg>
  );
};

export const AbsoluteCenter: React.FC<{ children: React.ReactNode }> = ({ children }) => <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>{children}</AbsoluteFill>;
