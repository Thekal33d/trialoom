import { strToU8, zipSync } from 'fflate';
import type { TraceReplay } from '../domain/replay.ts';
import { scanText } from './redaction.ts';
import { readTraceArchive } from './trace-archive.ts';

export const tracePolicy = 'playwright-metadata-v1';
export const traceOmissions = [
  'Page snapshots, screenshots and source files',
  'Typed values, selectors, URLs, headers, cookies and request/response bodies',
  'Console messages, error details, attachments, file paths and original identifiers',
] as const;
const methods = new Set([
  'goto',
  'fill',
  'click',
  'dblclick',
  'press',
  'check',
  'uncheck',
  'selectOption',
  'hover',
  'focus',
  'textContent',
  'innerText',
  'getAttribute',
  'evaluateExpression',
  'evaluateExpressionHandle',
  'waitForFunction',
  'waitForSelector',
  'isVisible',
  'isEnabled',
  'count',
  'screenshot',
  'reload',
  'goBack',
  'goForward',
  'newPage',
  'close',
  'cookies',
  'addCookies',
  'clearCookies',
]);
const classes = new Set(['Frame', 'Page', 'BrowserContext', 'ElementHandle', 'JSHandle']);
const ignored = new Set([
  'event',
  'frame-snapshot',
  'log',
  'input',
  'console',
  'screencast-frame',
  'screenshot',
  'video',
  'aria-snapshot',
  'stdout',
  'stderr',
  'error',
]);
const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
type Event = Record<string, unknown>;
const object = (value: unknown): Event => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid trace record.');
  return value as Event;
};
const number = (value: unknown) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    throw new Error('Invalid trace timing.');
  return value;
};
const id = (value: unknown) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw new Error('Invalid trace identifier.');
  return value;
};
function records(bytes: Uint8Array) {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n');
  if (lines.length > 10000) throw new Error('Too many trace records.');
  return lines.filter(Boolean).map((line) => {
    if (line.length > 1024 * 1024) throw new Error('Trace record too large.');
    return object(JSON.parse(line));
  });
}

/**
 * Rebuild a metadata-only trace from a closed set of scalars. No source string
 * (including nested DOM, bodies, arbitrary secret shapes or encoded values) is
 * copied. The original stays private. This is not a general DOM sanitizer.
 */
export function sanitizeBrowserTrace(bytes: Uint8Array, secrets: string[] = []) {
  try {
    const files = readTraceArchive(bytes);
    const traces = [...files.keys()].filter((name) => name.endsWith('.trace'));
    if (traces.length !== 1 || files.has('replay.json'))
      throw new Error('Unsupported trace layout.');
    const stem = traces[0].slice(0, -6);
    if (
      [...files.keys()].some(
        (name) =>
          !name.startsWith('resources/') &&
          ![`${stem}.trace`, `${stem}.network`, `${stem}.stacks`].includes(name),
      )
    )
      throw new Error('Unsupported trace layout.');
    const events = records(files.get(traces[0]) as Uint8Array);
    const context = events[0];
    if (
      context?.type !== 'context-options' ||
      context.version !== 10 ||
      !['chromium', 'firefox', 'webkit'].includes(String(context.browserName))
    )
      throw new Error('Unsupported Playwright trace version.');
    const base = number(context.monotonicTime);
    const time = (value: unknown) => {
      const relative = Math.round(number(value) - base);
      if (relative < 0 || relative > 86400000) throw new Error('Trace timing out of bounds.');
      return relative;
    };
    const replay: TraceReplay = { schemaVersion: 1, actions: [], requests: [] };
    const trace: Event[] = [
      {
        type: 'context-options',
        version: 10,
        origin: 'library',
        browserName: context.browserName,
        title: 'Sanitized browser trace',
        platform: 'redacted',
        wallTime: 0,
        monotonicTime: 0,
        sdkLanguage: 'javascript',
        options: {},
      },
    ];
    const actions = new Map<string, TraceReplay['actions'][number]>();
    for (const event of events.slice(1)) {
      if (ignored.has(String(event.type))) continue;
      if (event.type === 'before') {
        const originalId = id(event.callId);
        if (actions.has(originalId)) throw new Error('Duplicate trace action.');
        const method = methods.has(String(event.method)) ? String(event.method) : 'unknown';
        const action: TraceReplay['actions'][number] = {
          index: actions.size + 1,
          method,
          startMs: time(event.startTime),
          endMs: null,
          status: 'incomplete',
        };
        actions.set(originalId, action);
        replay.actions.push(action);
        trace.push({
          type: 'before',
          callId: `call@${action.index}`,
          startTime: action.startMs,
          class: classes.has(String(event.class)) ? event.class : 'Frame',
          method,
          params: {},
        });
      } else if (event.type === 'after') {
        const action = actions.get(id(event.callId));
        if (!action || action.endMs !== null) throw new Error('Unmatched trace action.');
        action.endMs = time(event.endTime);
        if (action.endMs < action.startMs) throw new Error('Invalid trace duration.');
        action.status = event.error ? 'error' : 'completed';
        trace.push({
          type: 'after',
          callId: `call@${action.index}`,
          endTime: action.endMs,
          ...(event.error
            ? { error: { name: 'Error', message: 'Action failed; details withheld.' } }
            : {}),
        });
      } else throw new Error('Unsupported trace event.');
    }
    if (actions.size === 0) throw new Error('No recorded browser actions.');
    const network: Event[] = [];
    const rawNetwork = files.get(`${stem}.network`);
    for (const event of rawNetwork ? records(rawNetwork) : []) {
      if (event.type !== 'resource-snapshot') throw new Error('Unsupported network record.');
      const snapshot = object(event.snapshot);
      const request = object(snapshot.request);
      const response = object(snapshot.response);
      // Playwright HAR uses -1 when no HTTP response was received. Preserve
      // that closed numeric sentinel; never copy its failure text or URL.
      const status = response.status === -1 ? -1 : number(response.status);
      if (!Number.isInteger(status) || status > 599) throw new Error('Invalid response status.');
      const startMs = time(snapshot._monotonicTime);
      const durationMs = Math.round(number(snapshot.time));
      if (durationMs > 86400000) throw new Error('Invalid request duration.');
      const method = httpMethods.has(String(request.method)) ? String(request.method) : 'OTHER';
      const index = replay.requests.length + 1;
      replay.requests.push({ index, method, status, startMs, durationMs });
      network.push({
        type: 'resource-snapshot',
        snapshot: {
          startedDateTime: new Date(startMs).toISOString(),
          time: durationMs,
          _monotonicTime: startMs,
          request: {
            method,
            url: `https://redacted.invalid/request/${index}`,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            queryString: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: 'application/octet-stream' },
            headersSize: -1,
            bodySize: -1,
            redirectURL: '',
          },
          cache: {},
          timings: { send: 0, wait: durationMs, receive: 0 },
        },
      });
    }
    const output = {
      'trace.trace': strToU8(`${trace.map((event) => JSON.stringify(event)).join('\n')}\n`),
      'trace.network': strToU8(`${network.map((event) => JSON.stringify(event)).join('\n')}\n`),
      'replay.json': strToU8(JSON.stringify(replay)),
    };
    for (const content of Object.values(output))
      if (Object.keys(scanText(new TextDecoder().decode(content), secrets)).length)
        throw new Error('Trace rescan failed.');
    return {
      bytes: zipSync(output, { level: 6 }),
      replay,
      record: {
        policy: tracePolicy,
        mode: 'trace',
        decision: 'redacted',
        verified: true,
        sourceVersion: 10,
        actions: replay.actions.length,
        requests: replay.requests.length,
        omitted: traceOmissions,
      },
    };
  } catch {
    // No parser exception includes source material in API responses or logs.
    return null;
  }
}
