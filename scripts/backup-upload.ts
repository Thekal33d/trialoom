// HOST-01 step 10. Upload one database backup to the shared bucket and prune old
// ones. Separate from src/server/storage.ts, which keys evidence by content
// digest and must not be reused for rotating operational copies.
// Usage: node scripts/backup-upload.ts <file> [--keep-days 14]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const { values, positionals } = parseArgs({
  options: { 'keep-days': { type: 'string', default: '14' } },
  allowPositionals: true,
});
const file = positionals[0];
assert(file, 'Usage: node scripts/backup-upload.ts <file> [--keep-days 14]');
const keepDays = Number(values['keep-days']);
assert(Number.isInteger(keepDays) && keepDays >= 1, 'keep-days must be a positive integer.');

const endpoint = process.env.TRIALOOM_S3_ENDPOINT;
const bucket = process.env.TRIALOOM_S3_BUCKET;
assert(endpoint && bucket, 'Shared storage is not configured; refusing to report a backup.');
assert.equal(new URL(endpoint).protocol, 'https:');

const bytes = await readFile(file);
assert(bytes.length > 0, 'Refusing to upload an empty backup.');
const key = `backups/${basename(file)}`;
const digest = createHash('sha256').update(bytes).digest('hex');

const client = new S3Client({
  endpoint: new URL(endpoint).origin,
  region: process.env.TRIALOOM_S3_REGION || 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.TRIALOOM_S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.TRIALOOM_S3_SECRET_ACCESS_KEY as string,
  },
});
try {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: 'application/gzip',
      ContentLength: bytes.length,
      Metadata: { sha256: digest },
    }),
    { abortSignal: AbortSignal.timeout(120_000) },
  );

  const cutoff = Date.now() - keepDays * 86_400_000;
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  const stale = (listed.Contents ?? []).filter(
    (object) => object.Key !== key && (object.LastModified?.getTime() ?? Date.now()) < cutoff,
  );
  if (stale.length)
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: stale.map((object) => ({ Key: object.Key as string })) },
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );

  console.log(
    JSON.stringify({
      event: 'backup.uploaded',
      key,
      bytes: bytes.length,
      sha256: digest,
      kept: (listed.KeyCount ?? 0) - stale.length,
      pruned: stale.length,
    }),
  );
} finally {
  client.destroy();
}
