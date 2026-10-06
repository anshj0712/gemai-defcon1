import Player from 'rrweb-player';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchReplay, type ReplayResponse } from './api';
import { clipWindow, formatOffset, forPlayer, isFlagEvent, tagColors, type FlagPayload, type Marker } from './markers';

/** Injected into the replay iframe: the outline drawn around the element a flag points at. */
const FLAGGED_CSS =
  '.cp-flagged { outline: 3px solid #ef4444 !important; outline-offset: 4px !important; box-shadow: 0 0 0 10px rgba(239, 68, 68, 0.25) !important; }';

const PLAYER_WIDTH = 960;
const PLAYER_HEIGHT = 540;

interface Props {
  sessionId: string;
  signalId: string | null;
}

/**
 * Session replay. The shopper's pointer is a blue ring with a fading trail; each click flashes.
 * Flagged moments are red marks on the timeline; when playback reaches one, the element is
 * outlined in red and a caption says what went wrong. Opens on a short clip around the chosen flag.
 */
export function ReplayPage({ sessionId, signalId }: Props) {
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState<(FlagPayload & { at: string }) | null>(null);
  const [selected, setSelected] = useState<Marker | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);

  useEffect(() => {
    let alive = true;
    fetchReplay(sessionId).then(
      (r) => alive && setData(r),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const playClip = useCallback((marker: Marker) => {
    const p = player.current;
    if (!p) return;
    const meta = p.getMetaData();
    const [start, end] = clipWindow(marker.replay_ts - meta.startTime, meta.totalTime);
    setSelected(marker);
    p.playRange(start, end, false);
  }, []);

  useEffect(() => {
    if (!data || !container.current) return;
    container.current.innerHTML = '';
    const p = new Player({
      target: container.current,
      props: {
        events: forPlayer(data.events, data.markers) as never,
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT,
        autoPlay: false,
        skipInactive: true,
        speedOption: [0.5, 1, 2, 4],
        tags: tagColors(data.markers),
        mouseTail: { duration: 900, lineCap: 'round', lineWidth: 4, strokeStyle: 'rgba(37, 99, 235, 0.75)' },
        insertStyleRules: [FLAGGED_CSS],
      },
    });
    player.current = p;

    const replayer = p.getReplayer();
    const timers: ReturnType<typeof setTimeout>[] = [];
    replayer.on('event-cast', (event: unknown) => {
      if (!isFlagEvent(event)) return;
      const flag = event.data.payload;
      const doc = replayer.iframe.contentDocument;
      const byId = flag.node_id !== null ? (replayer.getMirror().getNode(flag.node_id) as Element | null) : null;
      const el = byId?.isConnected ? byId : flag.selector ? (doc?.querySelector(flag.selector) ?? null) : null;
      el?.classList.add('cp-flagged');
      setCaption({ ...flag, at: formatOffset(event.timestamp - p.getMetaData().startTime) });
      timers.push(setTimeout(() => el?.classList.remove('cp-flagged'), 2500));
      timers.push(setTimeout(() => setCaption(null), 4000));
    });

    const first = data.markers.find((m) => m.signal_id === signalId) ?? data.markers[0];
    if (first) playClip(first);
    else p.play();

    return () => {
      timers.forEach(clearTimeout);
      // A Svelte component: $destroy exists at runtime, but svelte's types are not installed.
      (p as unknown as { $destroy(): void }).$destroy();
      player.current = null;
    };
  }, [data, signalId, playClip]);

  if (error) return <p className="muted">Could not load this session ({error}).</p>;
  if (!data) return <p className="muted">Loading session…</p>;

  const duration = formatOffset(data.session.ended_at - data.session.started_at);
  // Offsets on the replay's own clock (browser timestamps), the same origin the player uses.
  const replayStart = data.events[0]?.timestamp ?? 0;
  return (
    <>
      <p>
        {/* Back to wherever the viewer came from (Issues, an issue, or Signals); Issues when opened directly. */}
        <a
          href="#/"
          onClick={(e) => {
            if (window.history.length > 1) {
              e.preventDefault();
              window.history.back();
            }
          }}
        >
          ← Back
        </a>
      </p>
      <h1>Session replay</h1>
      <p className="muted">
        <code>{data.session.session_id}</code> · {data.session.route} · release {data.session.release} · {data.session.chunks} batches ·{' '}
        {duration}
      </p>
      <div className="replay-layout">
        <div className="player-col">
          <div className="caption-slot">
            {caption ? (
              <div className="caption">
                <strong>⚠ {caption.at}</strong> {caption.label}
              </div>
            ) : (
              <div className="legend">
                <span className="dot blue" /> shopper's pointer and trail <span className="dot rose" /> click <span className="dot red" /> flagged
                element and timeline mark <span className="dot pink" /> JS error
              </div>
            )}
          </div>
          <div ref={container} className="player" />
        </div>
        <aside className="flags">
          <h3>Flagged moments ({data.markers.length})</h3>
          {data.markers.length === 0 && <p className="muted">Nothing flagged in this session.</p>}
          {data.markers.map((m) => (
            <button key={m.signal_id} type="button" className={`flag ${selected?.signal_id === m.signal_id ? 'active' : ''}`} onClick={() => playClip(m)}>
              <span className="flag-time">{formatOffset(m.replay_ts - replayStart)}</span>
              <span>{m.label}</span>
            </button>
          ))}
          <div className="actions">
            <button type="button" className="btn primary" disabled={!selected} onClick={() => selected && playClip(selected)}>
              ▶ Replay flagged moment
            </button>
            <button type="button" className="btn" onClick={() => player.current?.goto(0, true)}>
              Play full session
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}
