const stages = ['INPUT', 'ADMISSION', 'PROXY', 'READY', 'RUNTIME'] as const;
export type BrokerStage = (typeof stages)[number];
const reasons = [
  'MANIFEST_ADDRESS_CHANGED',
  'DNS_CHANGED',
  'TARGET_UNRESOLVED',
  'TARGET_PRIVATE',
  'PREVIEW_ORIGIN_INVALID',
  'PREVIEW_SCOPE_INVALID',
  'PREVIEW_SCOPE_OVERLAP',
  'ERR_ASSERTION',
  'INTERNAL',
];

/** A closed wire vocabulary: never serialize error messages, targets or input. */
export function brokerFailure(error: unknown, stage: BrokerStage) {
  const item = error as { code?: unknown; message?: unknown; originIndex?: unknown } | null;
  const reason =
    [item?.code, item?.message].find(
      (value): value is string => typeof value === 'string' && reasons.includes(value),
    ) ?? 'INTERNAL';
  const index = item?.originIndex;
  return `PREVIEW_BROKER_FAILED:${stage}:${reason}:${Number.isInteger(index) && Number(index) >= 0 && Number(index) < 8 ? index : '-'}`;
}

export function readBrokerFailure(stderr: string) {
  if (stderr.length > 16384) return undefined;
  return stderr.split('\n').find((line) => {
    const [prefix, stage, reason, index, extra] = line.split(':');
    return (
      prefix === 'PREVIEW_BROKER_FAILED' &&
      stages.includes(stage as BrokerStage) &&
      reasons.includes(reason) &&
      /^(?:[0-7]|-)$/.test(index ?? '') &&
      extra === undefined
    );
  });
}
