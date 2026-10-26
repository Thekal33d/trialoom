import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { canaries, fixtureId } from './fixture.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 32 * 1024 * 1024;

export function readTrace(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('Trace exceeds size limit.');
  let expanded = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize;
    if (expanded > MAX_BYTES) throw new Error('Expanded trace exceeds size limit.');
    return true;
  } });
  if (!Object.keys(entries).some(name => name.endsWith('.trace'))) throw new Error('Trace events are missing.');
  for (const [name, data] of Object.entries(entries)) {
    if (!/^(?:[\w.-]+\.(?:trace|network|stacks)|(?:resources|attachments)\/[a-f0-9]{40}(?:\.[\w-]+)?)$/.test(name)) {
      throw new Error('Unsupported trace entry: ' + name);
    }
    // This fixture exports text-only evidence. Screenshots, binaries and unknown
    // encodings require a different reviewed policy and are refused here.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (name.startsWith('attachments/')) {
      const evidence = JSON.parse(text);
      if (evidence.schemaVersion !== 1 || evidence.fixtureId !== fixtureId) throw new Error('Unsupported trace attachment.');
    }
  }
  return entries;
}

export function sanitizeTrace(bytes, privatePaths = []) {
  const entries = readTrace(bytes);
  const redactions = [...canaries, ...privatePaths.filter(Boolean)];
  const found = new Set();
  let replacements = 0;
  const clean = text => {
    for (const value of redactions) {
      if (text.includes(value)) {
        found.add(value);
        replacements += text.split(value).length - 1;
        text = text.replaceAll(value, '[REDACTED]');
      }
    }
    return text;
  };
  const output = {};
  const resourceNames = new Map();
  for (const [name, data] of Object.entries(entries)) {
    if (!name.includes('/')) continue;
    const sanitized = strToU8(clean(new TextDecoder().decode(data)));
    const [prefix, oldName] = name.split('/');
    const newName = createHash('sha1').update(sanitized).digest('hex') + oldName.slice(40);
    resourceNames.set(oldName, newName);
    output[prefix + '/' + newName] = sanitized;
  }
  for (const [name, data] of Object.entries(entries)) {
    if (name.includes('/')) continue;
    let text = clean(new TextDecoder().decode(data));
    for (const [oldName, newName] of resourceNames) text = text.replaceAll(oldName, newName);
    // Refuse damaged trace JSON rather than producing a plausible broken export.
    if (name.endsWith('.stacks')) JSON.parse(text);
    else for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
    output[name] = strToU8(text);
  }
  if (!canaries.every(value => found.has(value))) throw new Error('Raw trace did not exercise every redaction canary.');
  for (const data of Object.values(output)) {
    const text = new TextDecoder().decode(data);
    if (redactions.some(value => text.includes(value))) throw new Error('Redaction verification failed.');
  }
  return {
    bytes: zipSync(output),
    audit: { policy: 'synthetic-fixture-text-only-v1', seededValuesRemoved: canaries.length, replacements, entryCount: Object.keys(output).length, screenshots: false },
  };
}

export function reportTests(report) {
  const tests = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) tests.push({ title: spec.title, ...test });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return tests;
}
