import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppError } from '../domain/errors.ts';

/**
 * Private, content-addressed evidence store. Artifact bytes never enter the
 * database or a log line, and the key is the digest, so the same bytes are
 * stored once. Hosted services share a private S3-compatible bucket; local
 * development retains a private directory. Authorization remains in evidence.ts.
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
const maximumObjectBytes = 32 * 1024 ** 2;
function objectKey(digest: string) {
  if (!key.test(digest)) throw new AppError('ARTIFACT_KEY_INVALID', 'Artifact key is invalid.');
  return `evidence/${digest.slice(0, 2)}/${digest}`;
}
export function evidenceStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = [
    env.TRIALOOM_S3_ENDPOINT,
    env.TRIALOOM_S3_BUCKET,
    env.TRIALOOM_S3_ACCESS_KEY_ID,
    env.TRIALOOM_S3_SECRET_ACCESS_KEY,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value))
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'Shared evidence storage is incompletely configured.',
      503,
    );
  let endpoint: URL;
  try {
    endpoint = new URL(values[0] as string);
  } catch {
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'Shared evidence storage has an invalid endpoint.',
      503,
    );
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    (endpoint.protocol !== 'https:' &&
      !(
        env.NODE_ENV === 'test' &&
        endpoint.protocol === 'http:' &&
        endpoint.hostname === '127.0.0.1'
      ))
  )
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'Shared evidence storage requires an HTTPS service endpoint.',
      503,
    );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values[1] as string))
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'Shared evidence storage has an invalid bucket.',
      503,
    );
  return {
    endpoint: endpoint.origin,
    bucket: values[1] as string,
    region: env.TRIALOOM_S3_REGION || 'auto',
    accessKeyId: values[2] as string,
    secretAccessKey: values[3] as string,
  };
}
function s3(config: NonNullable<ReturnType<typeof evidenceStorageConfig>>) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
  });
}
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
  if (!bytes.length || bytes.length > maximumObjectBytes)
    throw new AppError(
      'ARTIFACT_TOO_LARGE',
      'Evidence must contain between 1 byte and 32 MiB.',
      413,
    );
  const digest = digestOf(bytes);
  const config = evidenceStorageConfig(env);
  if (config) {
    const client = s3(config);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey(digest),
          Body: bytes,
          ContentType: 'application/octet-stream',
          ContentLength: bytes.length,
          Metadata: { sha256: digest },
          // No public ACL, presigned URL, customer-controlled key, or automatic bucket creation.
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      return { key: digest, bytes: bytes.length };
    } catch {
      throw new AppError(
        'ARTIFACT_STORE_UNAVAILABLE',
        'Evidence storage is unavailable. The submission has not been accepted.',
        503,
      );
    } finally {
      client.destroy();
    }
  }
  const root = evidenceRoot(env);
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
  const config = evidenceStorageConfig(env);
  try {
    let bytes: Buffer;
    if (config) {
      const client = s3(config);
      let body: Readable | undefined;
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: objectKey(digest) }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
        body = response.Body as Readable | undefined;
        if (!body || (response.ContentLength ?? 0) > maximumObjectBytes)
          throw new Error('OBJECT_SIZE');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of body) {
          size += chunk.length;
          if (size > maximumObjectBytes) throw new Error('OBJECT_SIZE');
          chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
      } finally {
        body?.destroy();
        client.destroy();
      }
    } else bytes = await readFile(/* turbopackIgnore: true */ pathFor(evidenceRoot(env), digest));
    if (bytes.length > maximumObjectBytes || digestOf(bytes) !== digest)
      throw new AppError(
        'ARTIFACT_CORRUPT',
        'The stored evidence failed its integrity check.',
        409,
      );
    return bytes;
  } catch (error) {
    if (error instanceof AppError && error.code === 'ARTIFACT_CORRUPT') throw error;
    throw new AppError('ARTIFACT_UNAVAILABLE', 'That stored artifact could not be read.', 503);
  }
}
