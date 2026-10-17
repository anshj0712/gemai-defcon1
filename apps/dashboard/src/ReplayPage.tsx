import Player from 'rrweb-player';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, PlayIcon, ArrowCounterClockwiseIcon, WarningIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fetchReplay, type ReplayResponse } from './api';
import { Eyebrow } from './components/common';
import { clipWindow, ERROR_COLOR, FLAG_COLORS, formatOffset, forPlayer, isFlagEvent, tagColors, type FlagPayload, type Marker } from './markers';

/** Injected into the replay iframe: the outline drawn around the element a flag points at. */
const FLAGGED_CSS =
  '.cp-flagged { outline: 3px solid #b13d34 !important; outline-offset: 4px !important; box-shadow: 0 0 0 10px rgba(177, 61, 52, 0.22) !important; }';

const PLAYER_WIDTH = 960;
const PLAYER_HEIGHT = 540;

/** The legend uses the player's own colors (replay.css and markers.ts), so it matches what the replay draws. */
const LEGEND: { label: string; color: string; ring?: boolean }[] = [
  { label: "shopper's pointer and trail", color: '#3d6fa8', ring: true },
  { label: 'click', color: '#b13d34' },
  { label: 'flagged element and timeline mark', color: FLAG_COLORS.dead_click ?? '#b13d34' },
  { label: 'JS error', color: ERROR_COLOR },
];

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

  // Back to wherever the viewer came from (Issues, an issue, or Signals); Issues when opened directly.
  const back = (
    <a
      href="#/"
      className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 self-start text-muted-foreground no-underline')}
      onClick={(e) => {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      }}
    >
      <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
      Back
    </a>
  );

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <Alert variant="destructive">
          <AlertTitle>Could not load this session</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading session">
        {back}
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-[984px_1fr] gap-5">
          <Skeleton className="h-[640px] rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  const duration = formatOffset(data.session.ended_at - data.session.started_at);
  // Offsets on the replay's own clock (browser timestamps), the same origin the player uses.
  const replayStart = data.events[0]?.timestamp ?? 0;
  return (
    <div className="flex flex-col gap-2">
      {back}
      <h1 className="m-0 font-display text-[34px] leading-[1.08] font-medium tracking-[-0.022em]">Session replay</h1>
      <p className="m-0 text-[13px] text-muted-foreground">
        <code>{data.session.session_id}</code> · {data.session.route} · release {data.session.release} · {data.session.chunks} batches · {duration}
      </p>
      <div className="mt-2 grid items-start gap-5 xl:grid-cols-[auto_1fr]">
        <Card className="gap-2 p-3">
          <div className="min-h-11">
            {caption ? (
              <div role="status" className="caption flex items-center gap-2 rounded-lg border border-danger-border bg-danger-muted px-3 py-2.5 font-medium text-money">
                <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
                <strong className="tabular-nums">{caption.at}</strong> {caption.label}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-xs text-muted-foreground">
                {LEGEND.map((l) => (
                  <span key={l.label} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block size-3 rounded-full" style={l.ring ? { border: `3px solid ${l.color}` } : { background: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div ref={container} className="player overflow-hidden rounded-lg" />
        </Card>
        <Card size="sm" className="gap-3 px-4">
          <Eyebrow>Flagged moments ({data.markers.length})</Eyebrow>
          {data.markers.length === 0 && <p className="m-0 text-sm text-muted-foreground">Nothing flagged in this session.</p>}
          <div className="flex flex-col gap-2">
            {data.markers.map((m) => {
              const active = selected?.signal_id === m.signal_id;
              return (
                <button
                  key={m.signal_id}
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    'flex w-full cursor-pointer items-baseline gap-3 rounded-lg bg-card px-3 py-2 text-left text-sm ring-1 ring-border transition-colors duration-200 hover:bg-muted',
                    active && 'bg-danger-muted ring-danger-border hover:bg-danger-muted',
                  )}
                  onClick={() => playClip(m)}
                >
                  <span className="shrink-0 rounded-[4px] bg-danger-muted px-1.5 font-mono text-[12px] font-medium text-money tabular-nums">{formatOffset(m.replay_ts - replayStart)}</span>
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex flex-col gap-2">
            <Button disabled={!selected} onClick={() => selected && playClip(selected)}>
              <ArrowCounterClockwiseIcon data-icon="inline-start" aria-hidden="true" />
              Replay flagged moment
            </Button>
            <Button variant="outline" onClick={() => player.current?.goto(0, true)}>
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
              Play full session
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
