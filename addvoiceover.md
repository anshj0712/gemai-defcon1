# Add the voice-over to the demo video

Instructions for an AI coding agent (or a person) on a fresh machine. They cover how to turn the silent demo video into the final narrated one without breaking anything. Read the whole file before changing code.

- **Goal:** narrate the existing silent video with the script below, render it, and put the result in `submission/`.
- **Length:** the team's target for this cut is 3:30 to 3:50, never over 4:00. Note: the AI Builder Cup asks for a demo video of about 3 minutes; if the team needs a short cut for the submission form, shorten `S` in `video/src/Demo.tsx` (start with `arch`, `results` and the act cards) rather than speeding up footage.
- **Do not change** anything under `apps/`, `packages/`, `infra/` or `sim/`. The video is a separate project in `video/`.
- **Never commit** API keys, `.env` files, `video/node_modules`, `video/out` or `video/.raw`.
- **All data in the video is synthetic** (simulated shoppers on a demo store). Keep any added claims true to the script below.

---

## 1. What exists today

| Item | Where |
| --- | --- |
| Silent video, current cut (3:33) | `submission/Churn Preventer Agent - demo video v4.mp4` |
| Remotion project that renders it | `video/` (Remotion 4.0.536, React 19, TypeScript) |
| Scene list, order and lengths | `video/src/Demo.tsx`: the `S` object and the `SCENES` array |
| Screen recordings | `video/public/clips/<id>.mp4` and `<id>.json` (interaction log the camera eases to) |
| Live numbers used by the animated scenes | `video/public/data.json` |
| How the clips were recorded | `video/scripts/capture.cjs` (`ONLY=arrive,browse node scripts/capture.cjs` re-records some) |

The composition is 1920x1080, 30 fps, id `Demo`. Each scene fades in over the previous one for `OVERLAP = 15` frames (0.5 s). The story is in three acts.

| # | Scene id | Seconds (`S`) | On screen |
| --- | --- | --- | --- |
| 1 | `intro` | 7 | "Find the bug. Rank the loss. Check the past." |
| 2 | `act1` | 4 | Act card: "The shopper." |
| 3 | `arrive` | 13 | Screen: the STRIDE home page, scroll to Trending |
| 4 | `browse` | 11 | Screen: product page, pick a size, add to bag, toast |
| 5 | `bag` | 9 | Screen: the bag (₹10,795), press Checkout |
| 6 | `checkout` | 15 | Screen: details filled in, Place Order, "We couldn't process your payment", retry, same error |
| 7 | `leave` | 10 | Animation: the bag empties, "Session ended · order not placed", "They leave. Nobody hears about it." |
| 8 | `act2` | 4 | Act card: "The merchant." |
| 9 | `agent` | 11 | Animation: the agent checklist ticking, then the issue card |
| 10 | `dashboard` | 12.5 | Screen: money lost, chart by issue, "Fix these first" |
| 11 | `issue` | 17 | Screen: issue page, repro steps, proof, the AI jury |
| 12 | `replay` | 11 | Screen: the real flagged replay of the failed payment |
| 13 | `rules` | 7 | Screen: the agent's suggested rules |
| 14 | `rescan` | 10 | Animation: 249 session dots, a scanner, 12 turn red |
| 15 | `history` | 9.5 | Screen: Time travel, striped "unnoticed" bars |
| 16 | `act3` | 4 | Act card: "The save." |
| 17 | `fix` | 10 | Screen: "Mark as fixed" pressed, the green "Marked fixed" banner |
| 18 | `retained` | 14 | Screen: the next shopper checks out, "Thanks, you're all set" |
| 19 | `arch` | 16 | Animation: the architecture diagram |
| 20 | `results` | 20.5 | Animation: count-up results, then the comparison table |
| 21 | `cta` | 8 | Closing card |

---

## 2. The voice-over script

One audio file per scene, named exactly `<scene id>.mp3` (or `.wav`), in `video/public/voice/`. All 21 are required (the act cards are short).

**Voice direction for every clip:** low-to-medium pitch (the team found the earlier voice far too high), warm, confident, conversational, like a founder showing the product to a friend. Not a newsreader. Act 1 is a small story, told gently; Act 2 picks up energy; Act 3 is warm and satisfied. Slow down on numbers. "…" marks a short pause.

**Voice tool:** the team does **not** want Sarvam. Use an expressive TTS such as ElevenLabs (Eleven v3, with tags like `[warm]`, `[confident]`) or Google Gemini TTS (style instructions in plain English). Ask the team which one and for the API key; keep the key in an environment variable only.

| Scene id | Text to speak | Delivery |
| --- | --- | --- |
| `intro` | Find the bug. Rank the loss. … Check the past. | Unhurried; small lift on "past" |
| `act1` | Act one. The shopper. | Quiet, like a chapter title |
| `arrive` | Meet a shopper. They land on the store, ready to buy, and scroll through what's trending this week. | Friendly, unhurried |
| `browse` | They find the pair they want, pick a size, and add it to the bag. | Easy, smiling |
| `bag` | One pair, ten thousand seven hundred and ninety-five rupees. On to checkout. | Light; slow on the price |
| `checkout` | They fill in every detail and press Place Order… and the payment fails. They try once more. Same error. | Let "fails" land; quieter on the retry |
| `leave` | So they close the tab. No order, no complaint. … Nobody hears about it. | Soft, a little sad, never dramatic |
| `act2` | Act two. The merchant. | Chapter title, a touch brighter |
| `agent` | Churn Preventer was watching. It reads every session, spots the failed payments, groups them into one issue, and Gemini explains the cause. | More energy; brisk list |
| `dashboard` | Every issue is ranked by rupees lost. Each colour is one bug, over time… and this card says what to fix first. | Confident; stress "rupees lost" and "fix first" |
| `issue` | Open it, and you get what happened, the steps to reproduce, and proof. Four AI jurors review the report… but the final call is made by code, not the model. | Steady; emphasis on "code" |
| `replay` | And here's the replay: the exact moment the payment failed, from the shopper's own session, with private details masked. | Slower, almost hushed: the key moment |
| `rules` | The agent also suggests rules. A person approves every one. | Light, matter-of-fact |
| `rescan` | Approve one, and it re-checks the last thirty days… finding twelve past shoppers in about ten seconds. | Building; smile on "ten seconds" |
| `history` | Time travel shows how long each bug went unnoticed. The striped part is damage nobody saw. | Reflective |
| `act3` | Act three. The save. | Chapter title, warm |
| `fix` | The team ships the fix and marks it done. If the bug ever comes back, the issue reopens by itself. | Calm, reassuring |
| `retained` | Now the next shopper checks out… places the order… and it goes through. Order confirmed. Shopper kept. | Warm, satisfied; a smile on "Shopper kept" |
| `arch` | Under the hood: one script tag, Pub Sub, five detectors and Gemini on Vertex AI, all on Google Cloud. Only real issues reach the model, so cost stays flat as traffic grows. | Technical but easy; do not rush the list |
| `results` | On two hundred and forty test shoppers with thirteen planted bugs, it found all eight visible bugs, with zero false alarms. … Replay tools show you rage clicks. Churn Preventer finds silent bugs, ranks them in rupees, and checks the past. | Proud but grounded; slow on "zero false alarms" |
| `cta` | Churn Preventer Agent. … Find the bug… before the shopper leaves. | Warm, final; pitch drops a little at the end |

Every number above is real: the bag total shown on screen (₹10,795), and test output (240 simulated shoppers, 13 planted bugs, 8 of 8 visible bugs found, 0 false alarms, a re-scan of about 10 s finding 12 past shoppers). Do not add rupee totals for the dashboard: those change as new sessions arrive.

---

## 3. Set up on a new machine

```bash
git clone https://github.com/anshj0712/gemai-defcon1.git
cd gemai-defcon1/video
npm ci                 # Node 20.19+ or 22+; Remotion downloads its own headless Chrome on first render
npx remotion studio    # preview in the browser; composition "Demo"
```

You do **not** need the rest of the repo installed, the live site, or any GCP access: the recordings and data are committed in `video/public/`. Do not re-run `scripts/capture.cjs` unless the team asks for fresh footage. If you do: it needs the live site, the repo's Playwright (`pnpm install` at the repo root) and an ffmpeg binary in `FFMPEG`; it changes clip timings (re-check section 5); and the `fix` clip presses "Mark as fixed" on the live demo, then "Reopen" right after, so check the issue is open again afterwards.

---

## 4. Wire the voice in (code changes, all in `video/src/Demo.tsx`)

1. **Put the clips in place.** Save the 21 files as `video/public/voice/<scene id>.mp3`.

2. **Record each clip's length.** Write `video/public/voice/lengths.json`, for example `{ "intro": 4.8, "act1": 1.9, ... }` (seconds, one decimal). Measure with ffprobe (`ffprobe -v error -show_entries format=duration -of csv=p=0 file.mp3`) or any audio library. Every scene id must be present.

3. **Make scene lengths follow the voice.** Replace the fixed `S` object with "the current value or the voice plus breathing room, whichever is longer":

   ```tsx
   import lengths from '../public/voice/lengths.json';

   const LEAD = 0.6;  // seconds of picture before the voice starts (after the 0.5 s fade-in)
   const TAIL = 0.6;  // seconds of picture after it ends
   const BASE = {
     intro: 7, act1: 4, arrive: 13, browse: 11, bag: 9, checkout: 15, leave: 10,
     act2: 4, agent: 11, dashboard: 12.5, issue: 17, replay: 11, rules: 7, rescan: 10, history: 9.5,
     act3: 4, fix: 10, retained: 14, arch: 16, results: 20.5, cta: 8,
   };
   const voice = lengths as Record<keyof typeof BASE, number>;
   const S = Object.fromEntries(
     Object.entries(BASE).map(([id, base]) => [id, Math.max(base, 0.5 + LEAD + voice[id as keyof typeof BASE] + TAIL)]),
   ) as typeof BASE;
   ```

   Everything else (`TOTAL_FRAMES`, each screen scene's playback speed, the text beats) is computed from `S` and adapts.

4. **Play the voice in each scene.** Import `Audio` and `staticFile`, and add the audio inside each scene's `<Sequence>` in `Demo`:

   ```tsx
   import { Audio } from '@remotion/media';
   import { AbsoluteFill, Sequence, staticFile } from 'remotion';

   // inside SCENES.map(...), next to the scene element:
   <Sequence key={s.id} from={start} durationInFrames={dur} name={s.id}>
     {i === 0 ? s.el : <FadeIn frames={OVERLAP}>{s.el}</FadeIn>}
     <Sequence from={(i === 0 ? 0 : OVERLAP) + Math.round(LEAD * FPS)} name={`${s.id}-voice`}>
       <Audio src={staticFile(`voice/${s.id}.mp3`)} />
     </Sequence>
   </Sequence>
   ```

   This exact change was type-checked against the current `Demo.tsx`. Remotion rules: drive everything from frames (no CSS animations), use `@remotion/media` for `Audio`, keep timing in frames computed with `FPS`.

5. **Optional background music.** If the team supplies a track, add one `<Audio src={staticFile('music.mp3')} volume={0.12} />` at the top level of `Demo` (outside the scene map) and fade it out over the last 2 s with a `volume` callback. Keep the voice clearly on top.

6. **Type-check:** `npx tsc` in `video/` must print nothing.

---

## 5. Limits that will break the video if ignored

- **Total length:** total = sum of `S` minus 0.5 s for each of the 20 scene boundaries. Today it is 3:33. Keep it under 4:00 (and see the note at the top about the Cup's 3-minute guidance). If the voice pushes it over, shorten the script first (start with `results` and `arch`), not the pictures.
- **Screen scenes cannot grow without limit.** A recording is slowed to fill its scene, but only down to 0.7x (`ScreenScene` in `src/Footage.tsx` and `at()` in `Demo.tsx` must use the same floor). Beyond these lengths the recording runs out before the scene ends:

  | Scene | Longest safe `S` (seconds) |
  | --- | --- |
  | `arrive` | 16.3 |
  | `browse` | 13.0 |
  | `bag` | 10.0 |
  | `checkout` | 16.3 |
  | `dashboard` | 12.8 |
  | `issue` | 19.5 |
  | `replay` | 11.3 |
  | `rules` | 7.2 |
  | `history` | 9.8 |
  | `fix` | 10.6 |
  | `retained` | 14.5 |

  If a voice line needs more, trim the line, or lower the 0.7 floor in both places to no less than 0.55. The animated scenes (`intro`, act cards, `leave`, `agent`, `rescan`, `arch`, `results`, `cta`) can grow freely.
- **Text beats inside screen scenes** are timed from each recording's interaction log, so they stay in sync when a scene stretches. Do not hard-code new times for them.
- **Do not rename scene ids**, or the voice files must be renamed to match.
- **Fonts** load from Google Fonts at render time (DM Sans via `@remotion/google-fonts`), so rendering needs internet.

---

## 6. Render and check

```bash
cd video
npx remotion render Demo out/demo.mp4 --codec=h264 --crf=18
```

Before handing it over:

1. **Length:** within the target (`ffprobe out/demo.mp4`).
2. **Sync:** render a few stills (`npx remotion still Demo --frame=<n> --scale=0.5 still.png`) and watch the whole video once. Each scene's voice starts after its fade-in and ends before the next scene's fade-in.
3. **Loudness:** voice peaks around -1 dB, average around -16 dB; adjust `volume` on `Audio` if needed.
4. **Nothing cut off:** no sentence ends abruptly at a scene change.
5. **Facts:** the spoken numbers match section 2.

---

## 7. Hand over

1. Copy the render to `submission/Churn Preventer Agent - demo video final.mp4` (keep the earlier versions).
2. Commit on a branch, open a pull request into `main`, and merge after a teammate has watched it. Commit only: `video/src/`, `video/public/voice/`, `submission/…final.mp4`, and this file if you improved it.
3. Upload the final video (YouTube or Drive) and put its link on the links slide of `submission/Churn Preventer Agent - AI Builder Cup deck.pptx` (the "Demo Video Link" line), replacing the bracketed placeholder.
