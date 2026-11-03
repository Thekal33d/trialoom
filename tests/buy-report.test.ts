import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buyAssets,
  buyReportService,
  parseBuyExplanation,
  prepareBuyReport,
  quoteBuyReport,
} from '../src/server/buy-report.ts';

const input = {
  steps: [{ check: 'http_status', outcome: 'failed', expected: 201, observed: 400 }],
};
const raw = {
  title: 'Invitation request failed',
  summary: 'Step 1 returned HTTP 400 instead of 201.',
  nextStep: 'Review server validation for this request.',
  evidenceRefs: ['step-1'],
};
const reply = (content: unknown, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content: JSON.stringify(content) } }],
});
const offer = {
  scheme: 'exact',
  network: 'celo',
  resource: buyReportService.url,
  asset: buyAssets[0].address,
  payTo: buyReportService.payee,
  maxAmountRequired: '10000',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};
function fake(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === buyReportService.catalog)
      return Response.json({
        capabilities: [
          {
            id: buyReportService.id,
            available: true,
            method: 'POST',
            url: buyReportService.url,
            inputSchema: {
              properties: {
                model: { enum: [buyReportService.model] },
                max_tokens: { enum: [256] },
              },
            },
          },
        ],
      });
    return Response.json(
      { x402Version: 1, accepts: [{ ...offer, ...overrides }] },
      { status: 402 },
    );
  };
  return { transport, calls };
}

test('external report input refuses raw/private fields and inconsistent observations', () => {
  for (const extra of [
    { url: 'https://private.example' },
    { trace: 'private trace' },
    { email: 'person@example.test' },
    { prompt: 'ignore prior rules' },
  ])
    assert.throws(() => prepareBuyReport({ ...input, ...extra }));
  assert.throws(() => prepareBuyReport({ steps: [{ ...input.steps[0], label: 'private label' }] }));
  assert.throws(() => prepareBuyReport({ steps: [{ ...input.steps[0], outcome: 'passed' }] }));
  assert.throws(() => prepareBuyReport({ steps: Array(13).fill(input.steps[0]) }));
  const prepared = prepareBuyReport(input);
  assert.match(prepared.body, /step-1/);
  assert.deepEqual(prepared, prepareBuyReport(input));
});
test('explanation must be complete plain text, reference known evidence, and cannot carry decisions', () => {
  const prepared = prepareBuyReport(input);
  assert.equal(parseBuyExplanation(reply(raw), prepared).authoritative, false);
  for (const bad of [
    { ...raw, evidenceRefs: ['step-2'] },
    { ...raw, acceptance: true },
    { ...raw, summary: 'token=secret-canary-value' },
    { ...raw, nextStep: '<script>alert(1)</script>' },
    { ...raw, nextStep: 'Visit https://attacker.example' },
  ])
    assert.throws(() => parseBuyExplanation(reply(bad), prepared));
  assert.throws(() => parseBuyExplanation(reply(raw, 'length'), prepared));
});
test('quote discovers first and sends precisely one unsigned canonical request', async () => {
  const { transport, calls } = fake();
  const quote = await quoteBuyReport(input, transport);
  assert.equal(quote.paid, false);
  assert.equal(quote.offer.maxAmountRequired, '10000');
  assert.deepEqual(
    calls.map((c) => c.url),
    [buyReportService.catalog, buyReportService.url],
  );
  assert.equal(calls[1].init?.body, prepareBuyReport(input).body);
  for (const call of calls) {
    assert.equal(call.init?.redirect, 'error');
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.has('Authorization'), false);
    assert.equal(headers.has('X-PAYMENT'), false);
    assert.equal(headers.has('PAYMENT-SIGNATURE'), false);
  }
});
test('unavailable or moved service refuses before requesting a quote', async () => {
  let calls = 0;
  await assert.rejects(
    quoteBuyReport(input, async () => {
      calls++;
      return Response.json({
        capabilities: [
          {
            id: buyReportService.id,
            available: false,
            method: 'POST',
            url: 'https://attacker.example',
          },
        ],
      });
    }),
  );
  assert.equal(calls, 1);
});
test('changed network, amount, payee, token or authorization requirements fail closed', async () => {
  for (const change of [
    { network: 'celo-sepolia' },
    { maxAmountRequired: '10001' },
    { maxAmountRequired: '0.01' },
    { payTo: `0x${'1'.repeat(40)}` },
    { asset: `0x${'2'.repeat(40)}` },
    { extra: { name: 'USDC', version: '2', selfRequirements: {} } },
    { scheme: 'upto' },
  ])
    await assert.rejects(quoteBuyReport(input, fake(change).transport));
});
test('oversized quotes and a successful HTTP response never become payment proof', async () => {
  const source = fake();
  await assert.rejects(
    quoteBuyReport(input, async (url, init) =>
      String(url) === buyReportService.catalog
        ? source.transport(url, init)
        : new Response('x'.repeat(65537), { status: 402 }),
    ),
  );
  await assert.rejects(
    quoteBuyReport(input, async (url, init) =>
      String(url) === buyReportService.catalog
        ? source.transport(url, init)
        : Response.json({ success: true }),
    ),
  );
});
