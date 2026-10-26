import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const fixtureRoot = fileURLToPath(new URL('./fixture/', import.meta.url));
export const fixtureId = 'invitation-plus-address-v1';
// Synthetic canaries, never real customer credentials or personal data.
export const canaries = ['trialoom-fixture-token-never-a-real-secret', 'Synthetic Private Owner 4729'];
export const fixtureFiles = ['app.js', 'index.html', 'validation.mjs'];

export async function buildIdentity(root = fixtureRoot) {
  const files = [];
  for (const name of fixtureFiles) {
    files.push({ path: name, sha256: createHash('sha256').update(await readFile(path.join(root, name))).digest('hex') });
  }
  return { id: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

export async function startFixture(root = fixtureRoot) {
  const build = await buildIdentity(root);
  const { isValidInvitationEmail } = await import(pathToFileURL(path.join(root, 'validation.mjs')));
  const invitations = new Set();
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', await readFile(path.join(root, 'index.html'))]],
    ['/app.js', ['text/javascript; charset=utf-8', await readFile(path.join(root, 'app.js'))]],
  ]);
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-fixture-build': build.id });
      response.end(JSON.stringify(body));
    };
    if (request.headers['x-fixture-token'] !== canaries[0]) return json(401, { message: 'Fixture access required.' });
    if (request.method === 'GET' && assets.has(request.url)) {
      const [type, body] = assets.get(request.url);
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'" });
      return response.end(body);
    }
    if (request.method === 'GET' && request.url === '/api/meta') {
      return json(200, { fixtureId, buildId: build.id, ownerName: canaries[1], invitationCount: invitations.size });
    }
    if (request.method !== 'POST' || request.url !== '/api/invitations') return json(404, { message: 'Unknown fixture route.' });
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) return json(413, { message: 'Fixture request too large.' });
      }
      const { email } = JSON.parse(body);
      if (!isValidInvitationEmail(email)) return json(400, { message: 'Enter a valid email address.' });
      if (invitations.has(email)) return json(409, { message: 'This teammate is already invited.' });
      invitations.add(email);
      return json(201, { email, message: 'Invitation created.' });
    } catch {
      return json(400, { message: 'Invalid fixture request.' });
    }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, build,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
