/* Reads the narration clips in public/audio and writes public/timeline.json: how long each scene's voice runs.
 * Re-run after the voice-over changes; the video lengths follow.   node scripts/timeline.cjs */
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'public', 'audio');
const wavSeconds = (buf) => {
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(o + 16);
    if (id === 'data') return Math.min(size, buf.length - o - 8) / byteRate;
    o += 8 + size;
  }
  throw new Error('bad wav');
};
const out = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.wav'))) out[f.replace('.wav', '')] = { audio: `audio/${f}`, secs: Number(wavSeconds(fs.readFileSync(path.join(dir, f))).toFixed(2)) };
fs.writeFileSync(path.join(__dirname, '..', 'public', 'timeline.json'), JSON.stringify(out, null, 1));
console.log(out);
