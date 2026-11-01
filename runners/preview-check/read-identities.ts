import { writeFile } from 'node:fs/promises';

/** Trusted supervisor input, private scratch only. Never log or bake keys into an image. */
export async function readIdentities() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 32 * 1024) throw new Error('FIXTURE_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  JSON.parse(input.toString());
  await writeFile('/scratch/identities.json', input, { mode: 0o600, flag: 'wx' });
}
