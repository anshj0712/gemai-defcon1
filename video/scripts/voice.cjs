// Generates the voice-over clips with ElevenLabs from ../voiceover-elevenlabs.txt, one mp3 per scene id, then writes
// public/voice/lengths.json. Existing clips are skipped, so a run that stops (credits, network) can resume.
// Key: ELEVENLABS_API_KEY from the environment or the repo's .env. Redo some: ONLY=intro,cta FORCE=1 node scripts/voice.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'public', 'voice');
const VOICE = process.env.VOICE_ID || 'nPczCjzI2devNBz1zQrb'; // Brian: deep, resonant, comforting
const MODEL = process.env.VOICE_MODEL || 'eleven_v3';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function key() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = env.match(/^ELEVENLABS_API_KEY=(.+)$/m);
  if (!m) throw new Error('ELEVENLABS_API_KEY missing');
  return m[1].trim();
}

function lines() {
  const txt = fs.readFileSync(path.join(ROOT, 'voiceover-elevenlabs.txt'), 'utf8').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < txt.length; i++) {
    const m = txt[i].match(/^\d\d\s+([a-z0-9]+)\.mp3/);
    if (!m) continue;
    const p = txt.indexOf('PASTE:', i);
    out.push({ id: m[1], text: txt[p + 1].trim() });
  }
  return out;
}

function seconds(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const all = lines();
  if (all.length !== 21) throw new Error(`expected 21 lines, got ${all.length}`);
  for (const { id, text } of all) {
    const file = path.join(OUT, `${id}.mp3`);
    if (only && !only.includes(id)) continue;
    if (fs.existsSync(file) && !process.env.FORCE) continue;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key(), 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5 } }),
    });
    if (!res.ok) {
      console.error(`${id}: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`${id}: ${seconds(file).toFixed(1)} s`);
  }
  const lengths = {};
  for (const { id } of all) {
    const file = path.join(OUT, `${id}.mp3`);
    if (fs.existsSync(file)) lengths[id] = Math.round(seconds(file) * 10) / 10;
  }
  fs.writeFileSync(path.join(OUT, 'lengths.json'), JSON.stringify(lengths, null, 2) + '\n');
  console.log(`lengths.json: ${Object.keys(lengths).length} of ${all.length}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
