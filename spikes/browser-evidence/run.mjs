import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { sanitizeTrace, reportTests, sha256 } from './evidence.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const spikeRoot = path.join(projectRoot, 'spikes/browser-evidence');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const runRoot = path.join(projectRoot, 'artifacts/browser-evidence', runId);
const rawRoot = path.join(runRoot, 'private');
const exportRoot = path.join(runRoot, 'export');
await mkdir(rawRoot, { recursive: true, mode: 0o700 });
await mkdir(exportRoot, { recursive: true, mode: 0o700 });
const reportPath = path.join(rawRoot, 'report.json');
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, [path.join(projectRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(spikeRoot, 'playwright.config.mjs'), 'reproduction.spec.mjs'], {
  cwd: projectRoot, stdio: 'inherit', timeout: 120000,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.cache/ms-playwright'), TRIALOOM_RAW_DIR: path.join(rawRoot, 'tests'), TRIALOOM_REPORT_PATH: reportPath },
});
if (result.error || result.status !== 0) {
  throw new Error(`Reproduction harness failed (exit ${result.status}). Private diagnostics: ${rawRoot}`, { cause: result.error });
}
const tests = reportTests(JSON.parse(await readFile(reportPath, 'utf8')));
if (tests.length !== 2) throw new Error('Expected exactly two reproduction runs.');
const artifacts = [];
const runs = [];
for (const [index, test] of tests.entries()) {
  const result = test.results.at(-1);
  if (result.status !== 'passed' || test.results.length !== 1) throw new Error('A clean reproduction did not pass.');
  const attachment = result.attachments.find(item => item.name === 'evidence.json');
  const evidence = JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64').toString() : await readFile(attachment.path, 'utf8'));
  if (evidence.assertions.length !== 2 || evidence.assertions[0].actual !== 201 || evidence.assertions[1].actual !== 400 || evidence.assertions[1].expected !== 201) {
    throw new Error('The observed failure is not the seeded defect.');
  }
  const trace = result.attachments.find(item => item.name === 'trace');
  const sanitized = sanitizeTrace(await readFile(trace.path), [projectRoot, os.homedir()]);
  const traceName = `replay-${index + 1}.trace.zip`;
  const evidenceName = `replay-${index + 1}.json`;
  evidence.executionOutcome = 'completed';
  evidence.productOutcome = 'failed';
  evidence.firstFailure = evidence.assertions.find(item => !item.passed).name;
  evidence.redaction = sanitized.audit;
  evidence.trace = traceName;
  for (const [name, bytes] of [[traceName, sanitized.bytes], [evidenceName, Buffer.from(JSON.stringify(evidence, null, 2) + '\n')]]) {
    await writeFile(path.join(exportRoot, name), bytes, { mode: 0o600 });
    artifacts.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
  }
  runs.push({ assignmentId: evidence.assignmentId, buildId: evidence.build.id, executionOutcome: evidence.executionOutcome, productOutcome: evidence.productOutcome });
}
if (new Set(runs.map(run => run.buildId)).size !== 1) throw new Error('Replays used different builds.');
const sourceFiles = [];
async function recordSources(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await recordSources(full);
    else if (/\.(mjs|js|html)$/.test(entry.name)) sourceFiles.push({ path: path.relative(projectRoot, full), sha256: sha256(await readFile(full)) });
  }
}
await recordSources(spikeRoot);
const manifest = {
  schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(),
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
  sourceTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim()),
  sourceFiles, lockfileSha256: sha256(await readFile(path.join(projectRoot, 'package-lock.json'))),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, playwright: '1.64.1' },
  independentOperator: false, limitation: 'Controlled local fixture; no production sandbox, general PII sanitizer, or independent operator proof.',
  runs, artifacts,
};
await writeFile(path.join(exportRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
// Read back and check the actual exported bytes, not just in-memory values.
for (const artifact of artifacts) {
  if (sha256(await readFile(path.join(exportRoot, artifact.path))) !== artifact.sha256) throw new Error('Export integrity mismatch.');
}
console.log(`\nTwo clean runs reproduced the defect. Export verified: ${exportRoot}`);
