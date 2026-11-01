import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { archiveLimits, readTraceArchive } from '../src/server/trace-archive.ts';
import { sanitizeBrowserTrace } from '../src/server/trace-redaction.ts';
import { traceCanary, traceFixture } from './helpers/trace.ts';

test('trace projection removes all free text and resources while preserving action results and HTTP status', () => {
  const result = sanitizeBrowserTrace(traceFixture(), [traceCanary]);
  assert(result);
  const files = readTraceArchive(result.bytes);
  assert.deepEqual([...files.keys()].sort(), ['replay.json', 'trace.network', 'trace.trace']);
  const text = [...files.values()].map((bytes) => new TextDecoder().decode(bytes)).join('\n');
  assert(!text.includes(traceCanary));
  assert(!text.includes(Buffer.from(traceCanary).toString('base64')));
  assert(!text.includes('frame-snapshot'));
  assert.deepEqual(result.replay.actions, [
    { index: 1, method: 'fill', startMs: 5, endMs: 10, status: 'completed' },
    { index: 2, method: 'click', startMs: 11, endMs: 20, status: 'error' },
  ]);
  assert.deepEqual(result.replay.requests, [
    { index: 1, method: 'POST', status: 400, startMs: 12, durationMs: 6 },
  ]);
  assert.equal(result.record.verified, true);
});

test('unknown versions, multiple contexts, unsafe paths and unknown archive files stay private', () => {
  assert.equal(sanitizeBrowserTrace(traceFixture(11)), null);
  for (const name of [
    'second.trace',
    '../trace.trace',
    '/trace.trace',
    'resources/../escape',
    'source.js',
    'replay.json',
  ])
    assert.equal(sanitizeBrowserTrace(traceFixture(10, { [name]: strToU8('secret') })), null);
});

test('unknown events, invalid timings, duplicates, unpaired completions and malformed JSON stay private', () => {
  const fixture = unzipSync(traceFixture());
  const initial = new TextDecoder()
    .decode(fixture['trace.trace'])
    .split('\n')
    .map((line) => JSON.parse(line));
  const variants = [
    [...initial, { type: 'future-event', secret: traceCanary }],
    initial.map((event) => (event.type === 'before' ? { ...event, startTime: -1 } : event)),
    [...initial, initial[1]],
    [...initial, { type: 'after', callId: 'missing', endTime: 1030 }],
  ];
  for (const events of variants) {
    fixture['trace.trace'] = strToU8(events.map((event) => JSON.stringify(event)).join('\n'));
    assert.equal(sanitizeBrowserTrace(zipSync(fixture)), null);
  }
  fixture['trace.trace'] = strToU8('{not json');
  assert.equal(sanitizeBrowserTrace(zipSync(fixture)), null);
});

test('an interrupted action stays incomplete and an unrecognized method never copies its name', () => {
  const files = unzipSync(traceFixture());
  const events = new TextDecoder()
    .decode(files['trace.trace'])
    .split('\n')
    .map((line) => JSON.parse(line));
  events.push({
    type: 'before',
    callId: 'unfinished',
    class: traceCanary,
    method: traceCanary,
    startTime: 1050,
  });
  files['trace.trace'] = strToU8(events.map((event) => JSON.stringify(event)).join('\n'));
  const result = sanitizeBrowserTrace(zipSync(files));
  assert(result);
  assert.deepEqual(result.replay.actions.at(-1), {
    index: 3,
    method: 'unknown',
    startMs: 50,
    endMs: null,
    status: 'incomplete',
  });
});

test('truncated ZIPs, CRC corruption, encryption and duplicate filenames are refused', () => {
  const valid = traceFixture();
  assert.equal(sanitizeBrowserTrace(valid.slice(0, -10)), null);
  const corrupt = Buffer.from(valid);
  corrupt[40] ^= 255;
  assert.equal(sanitizeBrowserTrace(corrupt), null);
  const encrypted = Buffer.from(valid);
  encrypted.writeUInt16LE(1, 6);
  assert.equal(sanitizeBrowserTrace(encrypted), null);
  const duplicate = Buffer.from(
    zipSync({ 'a.trace': strToU8('a'), 'b.trace': strToU8('b') }, { level: 0 }),
  );
  for (let i = 0; i < duplicate.length - 7; i++)
    if (duplicate.subarray(i, i + 7).toString() === 'b.trace') duplicate[i] = 97;
  assert.throws(() => readTraceArchive(duplicate));
});

test('expanded size and entry count are bounded, including discarded resources', () => {
  const huge = traceFixture(10, {
    'resources/large.txt': new Uint8Array(archiveLimits.expandedBytes + 1),
  });
  assert.equal(sanitizeBrowserTrace(huge), null);
  const entries = Object.fromEntries(
    Array.from({ length: archiveLimits.entries }, (_, i) => [`resources/${i}`, strToU8('x')]),
  );
  assert.equal(sanitizeBrowserTrace(traceFixture(10, entries)), null);
});

test('lying about expanded size cannot bypass the inflater output cap', () => {
  const bytes = Buffer.from(zipSync({ 'trace.trace': new Uint8Array(4096).fill(65) }));
  bytes.writeUInt32LE(1, 22);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(1, central + 24);
  assert.throws(() => readTraceArchive(bytes));
});

test('a failed network request preserves no-response status without exposing failure details', () => {
  const files = unzipSync(traceFixture());
  const network = JSON.parse(new TextDecoder().decode(files['trace.network']));
  network.snapshot.response.status = -1;
  network.snapshot._failureText = traceCanary;
  files['trace.network'] = strToU8(JSON.stringify(network));
  const projected = sanitizeBrowserTrace(zipSync(files), [traceCanary]);
  assert(projected);
  assert.equal(projected.replay.requests[0].status, -1);
  const clean = readTraceArchive(projected.bytes);
  assert(
    ![...clean.values()].some((bytes) => new TextDecoder().decode(bytes).includes(traceCanary)),
  );
  for (const status of [-2, '-1', 600, 1.5]) {
    network.snapshot.response.status = status;
    files['trace.network'] = strToU8(JSON.stringify(network));
    assert.equal(sanitizeBrowserTrace(zipSync(files)), null);
  }
});

test('unfinished requests preserve only the known unknown-duration marker, without private values', () => {
  const files = unzipSync(traceFixture());
  const event = JSON.parse(new TextDecoder().decode(files['trace.network']));
  event.snapshot.time = -1;
  event.snapshot.response.status = -1;
  event.snapshot._failureText = traceCanary;
  files['trace.network'] = strToU8(JSON.stringify(event));
  const result = sanitizeBrowserTrace(zipSync(files), [traceCanary]);
  assert(result);
  assert.equal(result.replay.requests[0].durationMs, -1);
  const clean = readTraceArchive(result.bytes);
  assert.equal(JSON.parse(new TextDecoder().decode(clean.get('trace.network'))).snapshot.time, -1);
  assert(
    ![...clean.values()].some((value) => new TextDecoder().decode(value).includes(traceCanary)),
  );
  for (const time of [-2, -0.5, '-1', null, 86400001]) {
    event.snapshot.time = time;
    files['trace.network'] = strToU8(JSON.stringify(event));
    assert.equal(sanitizeBrowserTrace(zipSync(files)), null);
  }
});
