import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { sanitizeTrace, readTrace } from '../evidence.mjs';
import { canaries, fixtureId } from '../fixture.mjs';

function sample() {
  const resource = JSON.stringify({ owner: canaries[1] });
  const name = createHash('sha1').update(resource).digest('hex') + '.json';
  return {
    '0.trace': strToU8(JSON.stringify({ type: 'before', token: canaries[0] }) + '\n'),
    '0.network': strToU8(JSON.stringify({ content: { _sha1: name } }) + '\n'),
    ['resources/' + name]: strToU8(resource),
  };
}
test('export removes seeded sensitive values and preserves content-addressed resource references', () => {
  const clean = sanitizeTrace(zipSync(sample()));
  const entries = unzipSync(clean.bytes);
  const resourceName = JSON.parse(new TextDecoder().decode(entries['0.network'])).content._sha1;
  const resource = entries['resources/' + resourceName];
  assert.ok(resource);
  assert.equal(createHash('sha1').update(resource).digest('hex'), resourceName.slice(0, 40));
  for (const bytes of Object.values(entries)) for (const canary of canaries) assert.equal(new TextDecoder().decode(bytes).includes(canary), false);
  assert.equal(clean.audit.seededValuesRemoved, 2);
});
test('missing canaries cannot falsely establish redaction coverage', () => {
  assert.throws(() => sanitizeTrace(zipSync({ '0.trace': strToU8('{}\n') })), /every redaction canary/);
});
test('binary evidence is refused under the text-only fixture policy', () => {
  const entries = sample();
  entries['resources/' + 'a'.repeat(40) + '.png'] = new Uint8Array([137, 80, 78, 71]);
  assert.throws(() => sanitizeTrace(zipSync(entries)), /encoded data/);
});
test('unknown archive entries are refused', () => {
  assert.throws(() => readTrace(zipSync({ ...sample(), 'unknown.txt': strToU8('unreviewed') })), /Unsupported trace entry/);
});
test('malformed trace JSON cannot be exported', () => {
  const entries = sample();
  entries['0.network'] = strToU8('not-json');
  assert.throws(() => sanitizeTrace(zipSync(entries)), SyntaxError);
});
test('only this fixture\'s structured JSON attachments are allowed', () => {
  const entries = sample();
  entries['attachments/' + 'b'.repeat(40)] = strToU8(JSON.stringify({ schemaVersion: 1, fixtureId, owner: canaries[1] }));
  assert.doesNotThrow(() => sanitizeTrace(zipSync(entries)));
  entries['attachments/' + 'b'.repeat(40)] = strToU8(JSON.stringify({ arbitrary: 'unreviewed attachment' }));
  assert.throws(() => sanitizeTrace(zipSync(entries)), /Unsupported trace attachment/);
});
