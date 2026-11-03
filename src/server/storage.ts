import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../domain/errors.ts';

/**
 * Private, content-addressed evidence store. Artifact bytes never enter the
 * database or a log line, and the key is the digest, so the same bytes are
 * stored once. This local directory stands in for the private object storage
 * recorded in the architecture; that service is not provisioned.
 */
export function evidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  // turbopackIgnore on this and the two calls below: the operator chooses this
  // directory at run time and it holds private evidence, so it is a mounted
  // volume, never content to bundle. Without the opt-out the bundler concludes
  // it must trace the whole project and copies every source file and all of
  // public/ into the server output.
  return resolve(/* turbopackIgnore: true */ env.TRIALOOM_EVIDENCE_DIR ?? 'artifacts/evidence');
}
const key = /^[a-f0-9]{64}$/;
function pathFor(root: string, digest: string) {
  if (!key.test(digest)) throw new AppError('ARTIFACT_KEY_INVALID', 'Artifact key is invalid.');
  return join(root, digest.slice(0, 2), digest);
}
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export async function putObject(
  bytes: Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ key: string; bytes: number }> {
  const root = evidenceRoot(env);
  const digest = digestOf(bytes);
  const target = pathFor(root, digest);
  await mkdir(join(/* turbopackIgnore: true */ root, digest.slice(0, 2)), {
    recursive: true,
    mode: 0o700,
  });
  // Write then rename so a reader never sees a partial artifact.
  const staged = `${target}.${randomUUID()}.part`;
  await writeFile(staged, bytes, { mode: 0o600 });
  await rename(staged, target);
  return { key: digest, bytes: bytes.length };
}
export async function getObject(
  digest: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  try {
    return await readFile(/* turbopackIgnore: true */ pathFor(evidenceRoot(env), digest));
  } catch {
    throw new AppError('ARTIFACT_UNAVAILABLE', 'That stored artifact could not be read.', 503);
  }
}
