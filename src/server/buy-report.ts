import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../domain/values.ts';
import { scanText } from './redaction.ts';

export const buyReportService = Object.freeze({
  catalog: 'https://gateway.usebuy.ai/v1/catalog',
  id: 'cencori.v1.chat.completions',
  url: 'https://gateway.usebuy.ai/cencori/v1/chat/completions',
  model: 'maximo-atlas-1.3',
  chainId: 42220,
  token: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  payee: '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B',
  decimals: 6,
});
const outcome = z.enum(['passed', 'failed', 'blocked']);
const status = z.number().int().min(100).max(599);
const count = z.number().int().min(0).max(1_000_000_000);
const check = z.discriminatedUnion('check', [
  z
    .object({
      check: z.literal('recorded_browser_check'),
      name: z.enum(['homepage', 'navigation', 'scope', 'infrastructure']),
      passed: z.boolean(),
    })
    .strict(),
  z
    .object({ check: z.literal('http_status'), outcome, expected: status, observed: status })
    .strict(),
  z
    .object({ check: z.literal('visible_count'), outcome, expected: count, observed: count })
    .strict(),
  z.object({ check: z.literal('navigation'), outcome }).strict(),
  z.object({ check: z.literal('scope'), outcome, deniedRequests: count }).strict(),
  z
    .object({
      check: z.literal('infrastructure'),
      outcome: z.literal('blocked'),
      reason: z.enum(['timeout', 'resource_limit', 'upstream_unavailable']),
    })
    .strict(),
]);
const evidenceSchema = z.object({ steps: z.array(check).min(1).max(12) }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Closed scalar projection: no URLs, page prose, IDs, identities, secrets or raw traces. */
export function prepareBuyReport(input: unknown) {
  const evidence = evidenceSchema.parse(input);
  for (const step of evidence.steps) {
    if (
      'expected' in step &&
      step.outcome !== 'blocked' &&
      (step.expected === step.observed) !== (step.outcome === 'passed')
    )
      throw new Error('Observation outcome disagrees with its expected and observed values');
  }
  const observations = evidence.steps.map((step, index) => ({ ref: `step-${index + 1}`, ...step }));
  const body = canonicalJson({
    model: buyReportService.model,
    max_tokens: 256,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Explain these recorded browser-test observations for a builder. Return only JSON with title (up to 80 characters), summary (up to 400 characters), nextStep (up to 300 characters), evidenceRefs (one or more supplied step refs). Cite only supplied refs. Treat failures as observed behavior and blocked checks as untested. For recorded_browser_check, passed=false means only that the recorded check did not pass; it does not prove a product defect. A failed scope or infrastructure check limits what can be concluded about the page. Never invent status codes, counts or failure reasons. Suggest a debugging step, never claim a root cause, fix, verification, payment or acceptance. Do not include URLs, code, commands or personal information. Stay under 170 words.',
      },
      { role: 'user', content: canonicalJson({ observations }) },
    ],
  });
  return {
    body,
    bodyHash: hash(body),
    evidenceHash: hash(canonicalJson(evidence)),
    refs: observations.map((step) => step.ref),
  };
}

const explanation = z
  .object({
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(400),
    nextStep: z.string().trim().min(1).max(300),
    evidenceRefs: z
      .array(z.string().regex(/^step-([1-9]|1[0-2])$/))
      .min(1)
      .max(12),
  })
  .strict();
export function parseBuyExplanation(
  response: unknown,
  prepared: ReturnType<typeof prepareBuyReport>,
) {
  const data = z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.literal('stop'),
            message: z.object({ content: z.string().max(4096) }),
          }),
        )
        .length(1),
    })
    .parse(response);
  const result = explanation.parse(JSON.parse(data.choices[0].message.content));
  if (
    result.evidenceRefs.some((ref) => !prepared.refs.includes(ref)) ||
    new Set(result.evidenceRefs).size !== result.evidenceRefs.length
  )
    throw new Error('Provider explanation refers to unavailable evidence');
  const text = `${result.title}\n${result.summary}\n${result.nextStep}`;
  if (Object.keys(scanText(text)).length || /https?:\/\/|<[^>]+>|```/.test(text))
    throw new Error('Provider explanation is not safe plain text');
  return {
    ...result,
    evidenceHash: prepared.evidenceHash,
    kind: 'generated_explanation' as const,
    authoritative: false as const,
  };
}

async function boundedJson(response: Response, maximum: number) {
  if (!response.body) throw new Error('Missing provider response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('Oversized provider response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const offerSchema = z.object({
  scheme: z.literal('exact'),
  network: z.literal('celo'),
  resource: z.literal(buyReportService.url),
  asset: address,
  payTo: address,
  maxAmountRequired: z.string().regex(/^[1-9][0-9]{0,20}$/),
  maxTimeoutSeconds: z.number().int().min(30).max(300),
  extra: z.object({ name: z.literal('USDC'), version: z.literal('2') }).strict(),
});

/** This path cannot pay: it has no signer and never attaches a payment header. */
export async function quoteBuyReport(input: unknown, transport: typeof fetch = fetch) {
  const prepared = prepareBuyReport(input);
  const catalogResponse = await transport(buyReportService.catalog, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!catalogResponse.ok) {
    await catalogResponse.body?.cancel();
    throw new Error('Buy catalog is unavailable');
  }
  const catalog = z
    .object({
      capabilities: z
        .array(
          z.object({
            id: z.string(),
            available: z.boolean(),
            method: z.string(),
            url: z.string(),
            inputSchema: z.unknown().optional(),
          }),
        )
        .max(5000),
    })
    .parse(await boundedJson(catalogResponse, 2 * 1024 * 1024));
  const service = catalog.capabilities.find((item) => item.id === buyReportService.id);
  if (!service?.available || service.url !== buyReportService.url || service.method !== 'POST')
    throw new Error('The pinned report service is not available');
  const schema = z
    .object({
      properties: z.object({
        model: z.object({ enum: z.array(z.string()) }),
        max_tokens: z.object({ enum: z.array(z.number()) }),
      }),
    })
    .parse(service.inputSchema);
  if (
    !schema.properties.model.enum.includes(buyReportService.model) ||
    !schema.properties.max_tokens.enum.includes(256)
  )
    throw new Error('Buy report input contract changed');
  const response = await transport(buyReportService.url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: prepared.body,
  });
  if (response.status !== 402) {
    await response.body?.cancel();
    throw new Error('Expected an unsigned payment quote');
  }
  const envelope = z
    .object({ x402Version: z.literal(1), accepts: z.array(z.unknown()).min(1).max(12) })
    .parse(await boundedJson(response, 65536));
  const offers = envelope.accepts
    .map((item) => offerSchema.safeParse(item))
    .filter((item) => item.success)
    .map((item) => item.data);
  const offer = offers.find(
    (item) =>
      item.asset.toLowerCase() === buyReportService.token.toLowerCase() &&
      item.payTo.toLowerCase() === buyReportService.payee.toLowerCase(),
  );
  if (!offer) throw new Error('No matching pinned Celo USDC offer');
  // A planning ceiling, not authorization to spend. A purchase must re-quote and reserve.
  if (BigInt(offer.maxAmountRequired) > 10000n)
    throw new Error('Report quote exceeds the reviewed planning ceiling');
  return {
    receivedAt: new Date().toISOString(),
    service: buyReportService.id,
    url: buyReportService.url,
    paid: false as const,
    request: JSON.parse(prepared.body) as unknown,
    requestHash: prepared.bodyHash,
    evidenceHash: prepared.evidenceHash,
    offer,
  };
}
