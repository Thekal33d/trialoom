// HOST-01 step 4. One private round trip against the configured shared bucket,
// run from each process that must reach it. It writes one small object, reads it
// back, and proves an unauthenticated reader cannot have it. It prints no
// credential and never falls back to the local evidence directory.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { digestOf, evidenceStorageConfig, getObject, putObject } from '../src/server/storage.ts';

const config = evidenceStorageConfig();
assert(
  config,
  'Shared evidence storage is not configured. This check must not pass against the local directory.',
);
assert.equal(new URL(config.endpoint).protocol, 'https:');

const bytes = randomBytes(2048);
const digest = digestOf(bytes);
const written = await putObject(bytes);
assert.equal(written.key, digest, 'Stored key must be the content digest.');
assert.equal(written.bytes, bytes.length);

const read = await getObject(digest);
assert.equal(digestOf(read), digest, 'Retrieved bytes must hash to the same digest.');
assert(read.equals(Buffer.from(bytes)), 'Retrieved bytes must match exactly.');

// Anonymous access to the object and to a bucket listing must both be refused.
const objectUrl = `${config.endpoint}/${config.bucket}/evidence/${digest.slice(0, 2)}/${digest}`;
const anonymous = await fetch(objectUrl, { signal: AbortSignal.timeout(15000) });
assert(!anonymous.ok, `An unauthenticated reader retrieved the object: ${anonymous.status}`);
const listing = await fetch(`${config.endpoint}/${config.bucket}`, {
  signal: AbortSignal.timeout(15000),
});
assert(!listing.ok, `An unauthenticated reader listed the bucket: ${listing.status}`);

console.log(
  JSON.stringify({
    event: 'evidence.storage_round_trip',
    user: process.getuid?.(),
    bucket: config.bucket,
    endpointHost: new URL(config.endpoint).hostname,
    bytes: written.bytes,
    digestMatched: true,
    anonymousObject: anonymous.status,
    anonymousListing: listing.status,
  }),
);
