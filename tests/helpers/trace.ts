import { strToU8, zipSync } from 'fflate';

export const traceCanary = 'private_customer_value_49xyz';
export function traceFixture(version = 10, extra: Record<string, Uint8Array> = {}) {
  const events = [
    {
      type: 'context-options',
      version,
      browserName: 'chromium',
      monotonicTime: 1000,
      options: { password: traceCanary },
    },
    {
      type: 'before',
      callId: traceCanary,
      class: 'Frame',
      method: 'fill',
      startTime: 1005,
      params: { value: traceCanary },
      secret: traceCanary,
    },
    { type: 'frame-snapshot', snapshot: { html: ['script', {}, traceCanary] } },
    { type: 'after', callId: traceCanary, endTime: 1010, result: traceCanary },
    { type: 'before', callId: 'second', class: 'Frame', method: 'click', startTime: 1011 },
    { type: 'after', callId: 'second', endTime: 1020, error: { message: traceCanary } },
    { type: 'console', text: Buffer.from(traceCanary).toString('base64') },
  ];
  const network = [
    {
      type: 'resource-snapshot',
      snapshot: {
        _monotonicTime: 1012,
        time: 6,
        request: {
          method: 'POST',
          url: `https://${traceCanary}.invalid/?secret=${traceCanary}`,
          headers: [{ name: 'Cookie', value: traceCanary }],
          postData: { text: traceCanary },
        },
        response: {
          status: 400,
          statusText: traceCanary,
          headers: [],
          content: { text: traceCanary },
        },
      },
    },
  ];
  return zipSync({
    'trace.trace': strToU8(events.map((event) => JSON.stringify(event)).join('\n')),
    'trace.network': strToU8(network.map((event) => JSON.stringify(event)).join('\n')),
    'trace.stacks': strToU8(JSON.stringify({ files: [traceCanary] })),
    'resources/secret.png': strToU8(traceCanary),
    ...extra,
  });
}
