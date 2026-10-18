import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import dashboardClip from '../public/clips/dashboard.json';
import historyClip from '../public/clips/history.json';
import issueClip from '../public/clips/issue.json';
import replayClip from '../public/clips/replay.json';
import rulesClip from '../public/clips/rules.json';
import shopClip from '../public/clips/shop.json';
import { Beat, ClipMeta, ScreenScene } from './Footage';
import { Arch } from './scenes/Arch';
import { Rescan } from './scenes/Rescan';
import { AgentRun, Cta, Intro, Problem, Results } from './scenes/Story';
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

const S = { intro: 6, problem: 9, shop: 13, agent: 9.5, dashboard: 12, issue: 12.5, replay: 11, rules: 5.5, rescan: 8, history: 7, arch: 14, results: 18, cta: 6.5 };

const ShopScene = () => {
  const ev = at(shopClip as ClipMeta, S.shop);
  const beats: Beat[] = [
    { t: 0.2, text: 'A shopper fills in checkout.' },
    { t: ev(6, 7), text: 'Places the order. *Payment fails.*' },
    { t: ev(8, 10.5), text: 'They try again. Same error.' },
  ];
  return <ScreenScene clip={shopClip as ClipMeta} id="shop" secs={S.shop} eyebrow="The bug" index="01 / 06" beats={beats} />;
};

const DashboardScene = () => {
  const ev = at(dashboardClip as ClipMeta, S.dashboard);
  return (
    <ScreenScene
      clip={dashboardClip as ClipMeta}
      id="dashboard"
      secs={S.dashboard}
      eyebrow="Rank"
      index="03 / 06"
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
    <ScreenScene
      clip={issueClip as ClipMeta}
      id="issue"
      secs={S.issue}
      eyebrow="Explain"
      index="04 / 06"
      beats={[
        { t: 0.2, text: 'Gemini explains *what happened.*' },
        { t: ev(2, 4), text: 'Steps to reproduce, each one cited.' },
        { t: ev(3, 6.5), text: 'Proof from the masked replay.' },
        { t: ev(6, 9.5), text: 'Four AI jurors review it. *Code decides.*' },
      ]}
    />
  );
};

const ReplayScene = () => (
  <ScreenScene
    clip={replayClip as ClipMeta}
    id="replay"
    secs={S.replay}
    eyebrow="Explain"
    index="04 / 06"
    beats={[
      { t: 0.2, text: 'Then the *flagged replay.*' },
      { t: 4.6, text: 'The exact moment the payment failed.' },
    ]}
  />
);

const RulesScene = () => (
  <ScreenScene
    clip={rulesClip as ClipMeta}
    id="rules"
    secs={S.rules}
    eyebrow="Look back"
    index="05 / 06"
    beats={[
      { t: 0.2, text: 'The agent also *suggests rules.*' },
      { t: 2.8, text: 'A person approves every one.' },
    ]}
  />
);

const HistoryScene = () => {
  const ev = at(historyClip as ClipMeta, S.history);
  return (
    <ScreenScene
      clip={historyClip as ClipMeta}
      id="history"
      secs={S.history}
      eyebrow="Look back"
      index="05 / 06"
      beats={[
        { t: 0.2, text: 'How long each bug *went unnoticed.*' },
        { t: ev(1, 3.2), text: 'Striped: damage found later by a new rule.' },
      ]}
    />
  );
};

const SCENES: { id: string; secs: number; el: React.ReactNode }[] = [
  { id: 'intro', secs: S.intro, el: <Intro /> },
  { id: 'problem', secs: S.problem, el: <Problem /> },
  { id: 'shop', secs: S.shop, el: <ShopScene /> },
  { id: 'agent', secs: S.agent, el: <AgentRun /> },
  { id: 'dashboard', secs: S.dashboard, el: <DashboardScene /> },
  { id: 'issue', secs: S.issue, el: <IssueScene /> },
  { id: 'replay', secs: S.replay, el: <ReplayScene /> },
  { id: 'rules', secs: S.rules, el: <RulesScene /> },
  { id: 'rescan', secs: S.rescan, el: <Rescan /> },
  { id: 'history', secs: S.history, el: <HistoryScene /> },
  { id: 'arch', secs: S.arch, el: <Arch /> },
  { id: 'results', secs: S.results, el: <Results /> },
  { id: 'cta', secs: S.cta, el: <Cta /> },
];

const frames = (secs: number) => Math.round(secs * FPS);
export const TOTAL_FRAMES = SCENES.reduce((n, s) => n + frames(s.secs), 0) - OVERLAP * (SCENES.length - 1);

/** Silent cut for now: the voice-over is added later, and scene lengths are set here. */
export const Demo: React.FC = () => {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      {SCENES.map((s, i) => {
        const start = from;
        const dur = frames(s.secs);
        from += dur - OVERLAP;
        return (
          <Sequence key={s.id} from={start} durationInFrames={dur} name={s.id}>
            {i === 0 ? s.el : <FadeIn frames={OVERLAP}>{s.el}</FadeIn>}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
