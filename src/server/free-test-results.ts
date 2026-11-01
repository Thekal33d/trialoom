import { z } from 'zod';
import type { FreeTestResult } from '../domain/free-tests.ts';
import { sanitizeBrowserTrace } from './trace-redaction.ts';

const outputSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  browser: z.string().regex(/^Chromium [\d.]{1,40}$/),
  outcome: z.enum(['executed', 'blocked']),
  assertions: z.array(z.object({ name: z.string().max(80), passed: z.boolean() })).max(12),
  trace: z
    .string()
    .min(1)
    .max(12 * 1024 ** 2)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const witnessSchema = z.object({
  closed: z.literal(true),
  budgetExceeded: z.unknown().nullable(),
  observations: z
    .array(z.object({ reason: z.string().max(80), count: z.number().int().min(1).max(100000) }))
    .min(1)
    .max(128),
});

/** Discard all page strings and raw trace bytes before any durable free-test write. */
export function projectFreeTestResult(
  raw: unknown,
  witness: unknown,
  sample: boolean,
): FreeTestResult {
  const output = outputSchema.parse(raw);
  const report = witnessSchema.parse(witness);
  const trace = sanitizeBrowserTrace(Buffer.from(output.trace, 'base64'));
  const passed = (name: string) =>
    output.assertions.filter((item) => item.name === name).length === 1 &&
    output.assertions.some((item) => item.name === name && item.passed);
  const scope = report.observations.every((item) =>
    ['ALLOWED', 'CANCELLED', 'DEADLINE'].includes(item.reason),
  );
  const infrastructure =
    report.budgetExceeded === null &&
    !report.observations.some((item) =>
      ['UPSTREAM_FAILED', 'DNS_DENIED', 'BUDGET_EXHAUSTED', 'DEADLINE'].includes(item.reason),
    );
  const checks: FreeTestResult['checks'] = [
    { check: 'homepage', passed: passed('homepage.rendered') },
    ...(sample ? [{ check: 'navigation' as const, passed: passed('navigation.rendered') }] : []),
    { check: 'scope', passed: scope },
    { check: 'infrastructure', passed: infrastructure },
  ];
  return {
    schemaVersion: 1,
    outcome:
      output.outcome === 'executed' && checks.every((item) => item.passed)
        ? 'completed'
        : 'blocked',
    startedAt: output.startedAt,
    finishedAt: output.finishedAt,
    browser: output.browser,
    revisionConfirmed: false,
    checks,
    replay: trace?.replay ?? null,
  };
}
