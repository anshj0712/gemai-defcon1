import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile } from 'remotion';
import arriveClip from '../public/clips/arrive.json';
import bagClip from '../public/clips/bag.json';
import browseClip from '../public/clips/browse.json';
import checkoutClip from '../public/clips/checkout.json';
import dashboardClip from '../public/clips/dashboard.json';
import fixClip from '../public/clips/fix.json';
import historyClip from '../public/clips/history.json';
import issueClip from '../public/clips/issue.json';
import replayClip from '../public/clips/replay.json';
import retainedClip from '../public/clips/retained.json';
import lengths from '../public/voice/lengths.json';
import rulesClip from '../public/clips/rules.json';
import { Beat, ClipMeta, ScreenScene } from './Footage';
import { Arch } from './scenes/Arch';
import { ActCard, Leave } from './scenes/Journey';
import { Rescan } from './scenes/Rescan';
import { AgentRun, Cta, Intro, Results } from './scenes/Story';
import { C, FPS } from './theme';
import { FadeIn } from './ui';

const OVERLAP = 15;

/** Scene seconds at which each logged interaction shows, given the playback rate the scene uses. */
function at(clip: ClipMeta, secs: number) {
  const rate = Math.max(0.7, Math.min(1.8, (clip.duration - clip.trim - 0.2) / secs));
  return (i: number, fallback: number) => {
    const e = clip.events[i];
    return e ? Math.max(0, (e.t - clip.trim) / rate - 0.2) : fallback;
  };
}

/**
 * Seconds per scene: the base length, or the voice line plus breathing room, whichever is longer. Ids are stable: one
 * voice file per id in public/voice (scripts/voice.cjs). A screen scene must stay within its recording at 0.7x, so it is
 * capped at MAX (see the safe-length table in addvoiceover.md).
 */
const LEAD = 0.6;
const TAIL = 0.6;
const BASE = {
  intro: 7,
  act1: 4,
  arrive: 13,
  browse: 11,
  bag: 9,
  checkout: 15,
  leave: 10,
  act2: 4,
  agent: 11,
  dashboard: 12.5,
  issue: 17,
  replay: 11,
  rules: 7,
  rescan: 10,
  history: 9.5,
  act3: 4,
  fix: 10,
  retained: 14,
  arch: 16,
  results: 20.5,
  cta: 8,
};
const MAX: Partial<Record<keyof typeof BASE, number>> = {
  arrive: 16.3,
  browse: 13,
  bag: 10,
  checkout: 16.3,
  dashboard: 12.8,
  issue: 19.5,
  replay: 11.3,
  rules: 7.2,
  history: 9.8,
  fix: 10.6,
  retained: 14.5,
};
const voice = lengths as Record<keyof typeof BASE, number>;
const S = Object.fromEntries(
  (Object.keys(BASE) as (keyof typeof BASE)[]).map((id) => [id, Math.min(MAX[id] ?? Infinity, Math.max(BASE[id], 0.5 + LEAD + voice[id] + TAIL))]),
) as typeof BASE;

const SHOPPER = '01 / 03';
const MERCHANT = '02 / 03';
const SAVE = '03 / 03';

const Screen: React.FC<{ clip: unknown; id: string; secs: number; eyebrow: string; index: string; beats: Beat[] }> = ({ clip, ...rest }) => <ScreenScene clip={clip as ClipMeta} {...rest} />;

const ArriveScene = () => {
  const ev = at(arriveClip as ClipMeta, S.arrive);
  return (
    <Screen
      clip={arriveClip}
      id="arrive"
      secs={S.arrive}
      eyebrow="The shopper"
      index={SHOPPER}
      beats={[
        { t: 0.2, text: 'A shopper arrives, *ready to buy.*' },
        { t: ev(1, 6), text: "Browses what's trending this week." },
      ]}
    />
  );
};

const BrowseScene = () => {
  const ev = at(browseClip as ClipMeta, S.browse);
  return (
    <Screen
      clip={browseClip}
      id="browse"
      secs={S.browse}
      eyebrow="The shopper"
      index={SHOPPER}
      beats={[
        { t: 0.2, text: 'Finds the *right pair.*' },
        { t: ev(1, 4), text: 'Picks a size.' },
        { t: ev(2, 6), text: 'Adds it to the bag.' },
      ]}
    />
  );
};

const BagScene = () => {
  const ev = at(bagClip as ClipMeta, S.bag);
  return (
    <Screen
      clip={bagClip}
      id="bag"
      secs={S.bag}
      eyebrow="The shopper"
      index={SHOPPER}
      beats={[
        { t: 0.2, text: 'Bag ready: one pair, ₹10,795.' },
        { t: ev(1, 5.5), text: 'On to *checkout.*' },
      ]}
    />
  );
};

const CheckoutScene = () => {
  const ev = at(checkoutClip as ClipMeta, S.checkout);
  return (
    <Screen
      clip={checkoutClip}
      id="checkout"
      secs={S.checkout}
      eyebrow="The shopper"
      index={SHOPPER}
      beats={[
        { t: 0.2, text: 'Fills in every detail.' },
        { t: ev(6, 9), text: 'Places the order. *Payment fails.*' },
        { t: ev(8, 12.5), text: 'Tries again. Same error.' },
      ]}
    />
  );
};

const DashboardScene = () => {
  const ev = at(dashboardClip as ClipMeta, S.dashboard);
  return (
    <Screen
      clip={dashboardClip}
      id="dashboard"
      secs={S.dashboard}
      eyebrow="The merchant"
      index={MERCHANT}
      beats={[
        { t: 0.2, text: 'Every issue, ranked by *rupees lost.*' },
        { t: ev(1, 4.5), text: 'Each colour is one bug, over time.' },
        { t: ev(2, 8.5), text: 'The red card says what to *fix first.*' },
      ]}
    />
  );
};

const IssueScene = () => {
  const ev = at(issueClip as ClipMeta, S.issue);
  return (
    <Screen
      clip={issueClip}
      id="issue"
      secs={S.issue}
      eyebrow="The merchant"
      index={MERCHANT}
      beats={[
        { t: 0.2, text: 'Gemini explains *what happened.*' },
        { t: ev(2, 5), text: 'Steps to reproduce, each one cited.' },
        { t: ev(3, 8.5), text: 'Proof from the masked replay.' },
        { t: ev(6, 13), text: 'Four AI jurors review it. *Code decides.*' },
      ]}
    />
  );
};

const ReplayScene = () => (
  <Screen
    clip={replayClip}
    id="replay"
    secs={S.replay}
    eyebrow="The merchant"
    index={MERCHANT}
    beats={[
      { t: 0.2, text: 'Then the *flagged replay.*' },
      { t: 4.6, text: 'The exact moment the payment failed.' },
    ]}
  />
);

const RulesScene = () => (
  <Screen
    clip={rulesClip}
    id="rules"
    secs={S.rules}
    eyebrow="The merchant"
    index={MERCHANT}
    beats={[
      { t: 0.2, text: 'The agent also *suggests rules.*' },
      { t: 3.4, text: 'A person approves every one.' },
    ]}
  />
);

const HistoryScene = () => {
  const ev = at(historyClip as ClipMeta, S.history);
  return (
    <Screen
      clip={historyClip}
      id="history"
      secs={S.history}
      eyebrow="The merchant"
      index={MERCHANT}
      beats={[
        { t: 0.2, text: 'How long each bug *went unnoticed.*' },
        { t: ev(1, 3.6), text: 'Striped: damage found later by a new rule.' },
      ]}
    />
  );
};

const FixScene = () => {
  const ev = at(fixClip as ClipMeta, S.fix);
  return (
    <Screen
      clip={fixClip}
      id="fix"
      secs={S.fix}
      eyebrow="The save"
      index={SAVE}
      beats={[
        { t: 0.2, text: 'The team ships *the fix.*' },
        { t: ev(1, 4.5), text: 'Marked fixed. It reopens by itself if it returns.' },
      ]}
    />
  );
};

const RetainedScene = () => {
  const ev = at(retainedClip as ClipMeta, S.retained);
  return (
    <Screen
      clip={retainedClip}
      id="retained"
      secs={S.retained}
      eyebrow="The save"
      index={SAVE}
      beats={[
        { t: 0.2, text: 'The next shopper checks out.' },
        { t: ev(6, 8), text: 'Places the order.' },
        { t: ev(7, 10), text: 'Order confirmed. *Shopper kept.*' },
      ]}
    />
  );
};

const SCENES: { id: keyof typeof S; el: React.ReactNode }[] = [
  { id: 'intro', el: <Intro /> },
  { id: 'act1', el: <ActCard index="01" title="The shopper." line="Arrives ready to buy. Leaves without a word." /> },
  { id: 'arrive', el: <ArriveScene /> },
  { id: 'browse', el: <BrowseScene /> },
  { id: 'bag', el: <BagScene /> },
  { id: 'checkout', el: <CheckoutScene /> },
  { id: 'leave', el: <Leave /> },
  { id: 'act2', el: <ActCard index="02" title="The merchant." line="Finds out what happened, and what it cost." /> },
  { id: 'agent', el: <AgentRun /> },
  { id: 'dashboard', el: <DashboardScene /> },
  { id: 'issue', el: <IssueScene /> },
  { id: 'replay', el: <ReplayScene /> },
  { id: 'rules', el: <RulesScene /> },
  { id: 'rescan', el: <Rescan /> },
  { id: 'history', el: <HistoryScene /> },
  { id: 'act3', el: <ActCard index="03" title="The save." line="Fix it once. Keep the next shopper." /> },
  { id: 'fix', el: <FixScene /> },
  { id: 'retained', el: <RetainedScene /> },
  { id: 'arch', el: <Arch /> },
  { id: 'results', el: <Results /> },
  { id: 'cta', el: <Cta /> },
];

const frames = (secs: number) => Math.round(secs * FPS);
export const TOTAL_FRAMES = SCENES.reduce((n, s) => n + frames(S[s.id]), 0) - OVERLAP * (SCENES.length - 1);

/** The full cut: each scene plays its voice line after its fade-in. */
export const Demo: React.FC = () => {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      {SCENES.map((s, i) => {
        const start = from;
        const dur = frames(S[s.id]);
        from += dur - OVERLAP;
        return (
          <Sequence key={s.id} from={start} durationInFrames={dur} name={s.id}>
            {i === 0 ? s.el : <FadeIn frames={OVERLAP}>{s.el}</FadeIn>}
            <Sequence from={(i === 0 ? 0 : OVERLAP) + Math.round(LEAD * FPS)} name={`${s.id}-voice`}>
              <Audio src={staticFile(`voice/${s.id}.mp3`)} />
            </Sequence>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
