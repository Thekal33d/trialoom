import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, fixtureRoot, canaries, buildIdentity } from '../fixture.mjs';

test('fixture authorization, accepted invites, duplicates, and invalid requests preserve behavior', async () => {
  const app = await startFixture(process.env.TRIALOOM_FIXTURE_ROOT || fixtureRoot);
  const headers = { 'x-fixture-token': canaries[0], 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(app.origin + '/api/meta')).status, 401);
    const meta = await fetch(app.origin + '/api/meta', { headers }).then(response => response.json());
    assert.equal(meta.invitationCount, 0);
    assert.equal(meta.buildId, app.build.id);
    const invite = body => fetch(app.origin + '/api/invitations', { method: 'POST', headers, body });
    assert.equal((await invite(JSON.stringify({ email: 'control@example.test' }))).status, 201);
    assert.equal((await invite(JSON.stringify({ email: 'control@example.test' }))).status, 409);
    assert.equal((await invite(JSON.stringify({ email: 'not-an-address' }))).status, 400);
    assert.equal((await invite('{')).status, 400);
    assert.equal((await invite('x'.repeat(4097))).status, 413);
    assert.equal((await fetch(app.origin + '/../../package.json', { headers })).status, 404);
  } finally { await app.close(); }
});

test('fresh fixture instances reset application state and retain the same content identity', async () => {
  const root = process.env.TRIALOOM_FIXTURE_ROOT || fixtureRoot;
  const first = await startFixture(root);
  const headers = { 'x-fixture-token': canaries[0] };
  try {
    await fetch(first.origin + '/api/invitations', { method: 'POST', headers, body: JSON.stringify({ email: 'first@example.test' }) });
  } finally { await first.close(); }
  const second = await startFixture(root);
  try {
    const meta = await fetch(second.origin + '/api/meta', { headers }).then(response => response.json());
    assert.equal(meta.invitationCount, 0);
    assert.equal(second.build.id, first.build.id);
    assert.equal((await buildIdentity(root)).id, first.build.id);
  } finally { await second.close(); }
});
