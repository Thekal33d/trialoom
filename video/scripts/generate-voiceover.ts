/**
 * Generates one MP3 per scene from ElevenLabs.
 *
 * The key comes from the environment, never from this file, and the MP3s are
 * git-ignored: the repository records the script, not the rendered speech.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { scenes } from '../src/scenes.ts';

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Set ELEVENLABS_API_KEY.');

// Eric — smooth and trustworthy, and the quickest of the candidates on the
// technical line, which keeps a 45-second demo from sprawling. Chosen by the
// user after hearing Daniel and Matilda read the same sentence.
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'cjVigY5qzO86Huf0OWal';
const outDir = new URL('../public/vo/', import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const scene of scenes) {
  const file = new URL(`${scene.id}.mp3`, outDir);
  if (existsSync(file) && !process.env.FORCE) {
    console.log(`skip  ${scene.id} (exists)`);
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: scene.vo,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`${scene.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  console.log(`write ${scene.id}  ${(audio.length / 1024).toFixed(0)} KB`);
}
console.log('done');
