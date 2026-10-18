# Add the voice-over to the demo video

Instructions for an AI coding agent (or a person) on a fresh machine. They cover how to turn the silent demo video into the final narrated one without breaking anything. Read the whole file before changing code.

- **Goal:** narrate the existing silent video with the script below, keep it under **3:00** (an AI Builder Cup rule), render it, and put the result in `submission/`.
- **Do not change** anything under `apps/`, `packages/`, `infra/` or `sim/`. The video is a separate project in `video/`.
- **Never commit** API keys, `.env` files, `video/node_modules`, `video/out` or `video/.raw`.
- **All data in the video is synthetic** (simulated shoppers on a demo store). Keep any added claims true to the script below.

---

## 1. What exists today

| Item | Where |
| --- | --- |
| Silent video, current cut (2:06) | `submission/Churn Preventer Agent - demo video v3.mp4` |
| Remotion project that renders it | `video/` (Remotion 4.0.536, React 19, TypeScript) |
| Scene list, order and lengths | `video/src/Demo.tsx`: the `S` object and the `SCENES` array |
| Screen recordings used by the screen scenes | `video/public/clips/<id>.mp4` and `<id>.json` (interaction log for the camera zoom) |
| Live numbers used by the animated scenes | `video/public/data.json` |
| Old placeholder voice clips | `video/public/audio/*.wav` and `video/public/timeline.json`. **Obsolete:** they belong to an earlier scene list and a voice the team rejected. Delete them; do not use them. |

The composition is 1920x1080, 30 fps, id `Demo`. Scenes play in this order. Each scene fades in over the previous one for `OVERLAP = 15` frames (0.5 s), so a scene starts 0.5 s before the previous one ends.

| # | Scene id | Seconds (`S`) | What is on screen |
| --- | --- | --- | --- |
| 1 | `intro` | 6 | "Find the bug. Rank the loss. Check the past." |
| 2 | `problem` | 9 | Bug names drifting; "Checkout bugs rarely get reported." then "Analytics show the drop. Not the cause." |
| 3 | `shop` | 13 | Screen: a shopper fills in checkout, presses Place Order, payment fails, tries again |
| 4 | `agent` | 9.5 | Animated agent checklist ticking, then the issue card with rupees lost |
| 5 | `dashboard` | 12 | Screen: dashboard, money-lost chart, "Fix these first" |
| 6 | `issue` | 12.5 | Screen: issue page, repro steps, proof, the AI jury |
| 7 | `replay` | 11 | Screen: the real flagged session replay at the failed payment |
| 8 | `rules` | 5.5 | Screen: the agent's suggested rules |
| 9 | `rescan` | 8 | Animation: 249 session dots, a scanner, 12 turn red |
| 10 | `history` | 7 | Screen: Time travel, striped "unnoticed" bars |
| 11 | `arch` | 14 | Animated architecture diagram |
| 12 | `results` | 18 | Count-up results, then a comparison table |
| 13 | `cta` | 6.5 | Closing card |

---

## 2. The voice-over script

One audio file per scene, named exactly `<scene id>.mp3` (or `.wav`), in `video/public/voice/`.

**Voice direction for every clip:** low-to-medium pitch (the team said the earlier voice was far too high), warm, confident, conversational, like a founder showing the product to a friend. Not a newsreader. Slight smile on good news, slower on numbers, short pauses where marked with "…".

**Voice tool:** the team does **not** want Sarvam. Use an expressive TTS such as ElevenLabs (Eleven v3, with tags like `[warm]`, `[confident]`) or Google Gemini TTS (style instructions in plain English). Ask the team which one and for the API key; keep the key in an environment variable only.

| Scene id | Text to speak | Delivery |
| --- | --- | --- |
| `intro` | Find the bug. Rank the loss. … Check the past. | Unhurried; small lift on "past" |
| `problem` | Checkout bugs rarely get reported. … Your analytics show the drop… but never the cause. | Quieter, confiding; lean on "never" |
| `shop` | Here's a shopper. Bag full, details filled in. They press Place Order… and the payment fails. They try again. Same error. … That sale is gone, and nobody on your team knows why. | A small story; let "fails" land; slow on the last line |
| `agent` | Churn Preventer catches it on its own. It reads every session, spots the failed payments, groups them into one issue, and Gemini explains the cause. | More energy; brisk list |
| `dashboard` | Every issue is ranked by rupees lost. Each colour is one bug, over time. … And this card tells you exactly what to fix first. | Confident; stress "rupees lost" and "fix first" |
| `issue` | Open one, and you get what happened, steps to reproduce, and proof. Four AI jurors review every report… but the final call is made by code, not the model. | Steady; emphasis on "code" |
| `replay` | And here's the replay: the exact moment the payment failed, from the shopper's own session, with private details masked. | Slower, almost hushed: the key moment |
| `rules` | The agent also suggests rules. A person approves every one. | Light, matter-of-fact |
| `rescan` | Approve a rule, and it re-checks the last thirty days… finding twelve past shoppers in about ten seconds. | Building; smile on "ten seconds" |
| `history` | Time travel shows how long each bug went unnoticed. The striped part is damage you'd never have seen. | Reflective |
| `arch` | Under the hood: one script tag, Pub Sub, five detectors and Gemini on Vertex AI, all on Google Cloud. Only real issues ever reach the model, so cost stays flat as traffic grows. | Technical but easy; do not rush the list |
| `results` | On two hundred and forty test shoppers with thirteen planted bugs, it found all eight visible bugs, with zero false alarms. … Replay tools show you rage clicks. Churn Preventer finds silent bugs, ranks them in rupees, and checks the past. | Proud but grounded; slow on "zero false alarms" |
| `cta` | Churn Preventer Agent. … Find the bug… before the shopper leaves. | Warm, final; pitch drops a little at the end |

Every number above is real test output (240 simulated shoppers, 13 planted bugs, 8 of 8 visible bugs found, 0 false alarms, a re-scan of about 10 s finding 12 past shoppers). Do not add rupee totals to the voice: the dashboard figures change as new sessions arrive.

---

## 3. Set up on a new machine

```bash
git clone https://github.com/anshj0712/gemai-defcon1.git
cd gemai-defcon1/video
npm ci                 # Node 20.19+ or 22+; Remotion downloads its own headless Chrome on first render
npx remotion studio    # preview in the browser; composition "Demo"
```

You do **not** need the rest of the repo installed, the live site, or any GCP access: the screen recordings and data are committed in `video/public/`. Do not run `npm run capture` unless the team asks for fresh footage (it needs the live site, the repo's Playwright via `pnpm install` at the root, and ffmpeg, and it changes the clip timings).

---

## 4. Wire the voice in (code changes, all in `video/src/Demo.tsx`)

1. **Put the clips in place.** Save the 13 files as `video/public/voice/<scene id>.mp3`. Delete `video/public/audio/` and `video/public/timeline.json` (obsolete).

2. **Record each clip's length.** Write `video/public/voice/lengths.json`, for example `{ "intro": 4.8, "problem": 7.9, ... }` (seconds, one decimal). Measure with ffprobe (`ffprobe -v error -show_entries format=duration -of csv=p=0 file.mp3`) or any audio library. Every scene id must be present.

3. **Make scene lengths follow the voice.** In `Demo.tsx`, import the lengths and replace the fixed `S` values with "the old value or the voice plus breathing room, whichever is longer":

   ```tsx
   import lengths from '../public/voice/lengths.json';

   const LEAD = 0.6;  // seconds of picture before the voice starts (after the 0.5 s fade-in)
   const TAIL = 0.6;  // seconds of picture after it ends
   const BASE = { intro: 6, problem: 9, shop: 13, agent: 9.5, dashboard: 12, issue: 12.5, replay: 11, rules: 5.5, rescan: 8, history: 7, arch: 14, results: 18, cta: 6.5 };
   const voice = lengths as Record<keyof typeof BASE, number>;
   const S = Object.fromEntries(
     Object.entries(BASE).map(([id, base]) => [id, Math.max(base, 0.5 + LEAD + voice[id as keyof typeof BASE] + TAIL)]),
   ) as typeof BASE;
   ```

   Leave the rest of the file as is: `TOTAL_FRAMES`, the screen scenes' playback speed and the text beats are all computed from `S`, so they adapt.

4. **Play the voice in each scene.** Import `Audio` and `staticFile`, give each entry in `SCENES` its id (already there), and add the audio inside each scene's `<Sequence>`:

   ```tsx
   import { Audio } from '@remotion/media';
   import { AbsoluteFill, Sequence, staticFile } from 'remotion';

   // inside the SCENES.map(...) return, next to the scene element:
   <Sequence key={s.id} from={start} durationInFrames={dur} name={s.id}>
     {i === 0 ? s.el : <FadeIn frames={OVERLAP}>{s.el}</FadeIn>}
     <Sequence from={(i === 0 ? 0 : OVERLAP) + Math.round(LEAD * FPS)} name={`${s.id}-voice`}>
       <Audio src={staticFile(`voice/${s.id}.mp3`)} />
     </Sequence>
   </Sequence>
   ```

   Rules from the Remotion skill: drive everything from frames (no CSS animations), use `@remotion/media` for `Audio`, and keep timing props in frames computed with `FPS`.

5. **Optional background music.** If the team supplies a track, add one `<Audio src={staticFile('music.mp3')} volume={0.12} />` at the top level of `Demo` (outside the scene map) and fade it out in the last 2 s with a `volume` callback. Keep the voice clearly on top.

6. **Type-check:** `npx tsc` in `video/` must print nothing.

---

## 5. Limits that will break the video if ignored

- **Total length must stay under 3:00.** Total = sum of `S` minus 0.5 s per scene boundary. Today it is 2:06. If the voice pushes it over 2:55, shorten the script (start with `results` and `arch`), not the pictures.
- **Screen scenes cannot grow without limit.** A screen recording is slowed down to fill its scene, but only to 0.7x (`ScreenScene` in `src/Footage.tsx`). Beyond these lengths the recording runs out before the scene ends:

  | Scene | Longest safe `S` (seconds) |
  | --- | --- |
  | `shop` | 16 |
  | `dashboard` | 13 |
  | `issue` | 19 |
  | `replay` | 11.3 |
  | `rules` | 7.2 |
  | `history` | 9.8 |

  If a voice clip needs more, either trim the line, or lower the 0.7 floor in `ScreenScene` (and in `at()` in `Demo.tsx`, which must use the same number) to no less than 0.55. Do not exceed these by any other means.
- **Text beats inside screen scenes** are timed from the recording's interaction log, so they stay in sync when a scene stretches. Do not hard-code new times for them.
- **Do not rename scene ids** or the voice files must be renamed to match.
- **Fonts and data load from the project.** The font is DM Sans via `@remotion/google-fonts` (needs internet at render time). `public/data.json` holds the live numbers used by the agent card; it is fine as committed.

---

## 6. Render and check

```bash
cd video
npx remotion render Demo out/demo.mp4 --codec=h264 --crf=18
```

Check before handing it over:

1. **Length:** under 3:00 (`ffprobe out/demo.mp4`).
2. **Sync:** render stills at a few frames (`npx remotion still Demo --frame=<n> --scale=0.5 still.png`) and watch the full video once. The voice for each scene must start after its fade-in and finish before the next scene's fade-in begins.
3. **Loudness:** voice peaks around -1 dB and average around -16 dB; adjust with `volume` on `Audio` if needed.
4. **Nothing cut off:** no sentence ends abruptly at a scene change.
5. **Facts:** the spoken numbers match section 2.

---

## 7. Hand over

1. Copy the render to `submission/Churn Preventer Agent - demo video final.mp4` (keep the earlier versions).
2. Commit on a branch, open a pull request into `main`, and merge after a teammate has watched it. Commit only: `video/src/`, `video/public/voice/`, the removal of `video/public/audio/` and `video/public/timeline.json`, `submission/…final.mp4`, and this file if you improved it.
3. Upload the final video (YouTube or Drive), and put its link on slide 13 of `submission/Churn Preventer Agent - AI Builder Cup deck.pptx` (the "Demo Video Link" line), replacing the bracketed placeholder.
