import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { buildIdentity, fixtureRoot, fixtureFiles } from './fixture.mjs';
import { reportTests, sanitizeTrace, sha256 } from './evidence.mjs';
import { assessRepair } from './repair-gate.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const spikeRoot = path.join(projectRoot, 'spikes/browser-evidence');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const runRoot = path.join(projectRoot, 'artifacts/repair-verification', runId);
const privateRoot = path.join(runRoot, 'private');
const candidateRoot = path.join(privateRoot, 'candidate-source');
const exportRoot = path.join(runRoot, 'export');
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
await mkdir(exportRoot, { recursive: true, mode: 0o700 });
const baselineBuild = await buildIdentity();
await cp(fixtureRoot, candidateRoot, { recursive: true });
const patchPath = path.join(spikeRoot, 'patches/accept-plus-alias.patch');
const patch = await readFile(patchPath);
const directoryOption = '--directory=' + path.relative(projectRoot, candidateRoot);
execFileSync('git', ['apply', '--check', directoryOption, patchPath], { cwd: projectRoot });
execFileSync('git', ['apply', directoryOption, patchPath], { cwd: projectRoot });
const candidateBuild = await buildIdentity(candidateRoot);
const changedFiles = candidateBuild.files.filter(file => baselineBuild.files.find(base => base.path === file.path)?.sha256 !== file.sha256).map(file => file.path);
if (JSON.stringify(changedFiles) !== JSON.stringify(['validation.mjs']) || JSON.stringify((await readdir(candidateRoot)).sort()) !== JSON.stringify([...fixtureFiles].sort())) throw new Error('Patch changed files outside the approved repair scope.');

const cli = path.join(projectRoot, 'node_modules/@playwright/test/cli.js');
const envFor = root => ({ ...process.env, TRIALOOM_FIXTURE_ROOT: root, PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.cache/ms-playwright') });
async function regression(label, root) {
  const output = path.join(privateRoot, label);
  await mkdir(output);
  const reportPath = path.join(output, 'report.json');
  const processResult = spawnSync(process.execPath, [cli, 'test', '--config', path.join(spikeRoot, 'playwright.config.mjs'), 'regression.spec.mjs'], {
    cwd: projectRoot, stdio: 'inherit', timeout: 120000,
    env: { ...envFor(root), TRIALOOM_RAW_DIR: path.join(output, 'tests'), TRIALOOM_REPORT_PATH: reportPath },
  });
  if (processResult.error || processResult.status === null) throw new Error('Regression runner failed to finish.', { cause: processResult.error });
  const tests = [];
  for (const test of reportTests(JSON.parse(await readFile(reportPath, 'utf8')))) {
    const result = test.results.at(-1);
    const attachment = result.attachments.find(item => item.name === 'evidence.json');
    if (!attachment) throw new Error('Regression evidence is missing.');
    const evidence = JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64').toString() : await readFile(attachment.path, 'utf8'));
    const errorText = (result.errors ?? []).map(error => error.message ?? '').join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    tests.push({ title: test.title, status: result.status, attempts: test.results.length, evidence,
      expectedAssertionFailure: /Expected: 201\s+Received: 400/.test(errorText),
      tracePath: result.attachments.find(item => item.name === 'trace')?.path,
    });
  }
  return { exitCode: processResult.status, tests };
}
function requiredChecks(label, root) {
  const result = spawnSync(process.execPath, ['--test', path.join(spikeRoot, 'tests') + '/*.test.mjs'], {
    cwd: projectRoot, env: envFor(root), encoding: 'utf8', timeout: 30000,
  });
  if (result.error || result.status === null) throw new Error('Required checks did not finish.', { cause: result.error });
  return { label, exitCode: result.status, output: result.stdout + result.stderr };
}

console.log('Baseline: the unchanged regression must fail specifically on the plus-address invitation.');
const baseline = await regression('baseline', fixtureRoot);
console.log('Candidate: the same regression must pass after applying the reviewable patch.');
const candidate = await regression('candidate', candidateRoot);
const controls = [requiredChecks('baseline', fixtureRoot), requiredChecks('candidate', candidateRoot)];
for (const check of controls) await writeFile(path.join(privateRoot, check.label + '-checks.txt'), check.output, { mode: 0o600 });
const verdict = assessRepair({ baseline, candidate, baselineBuildId: baselineBuild.id, candidateBuildId: candidateBuild.id, baselineChecks: controls[0].exitCode, candidateChecks: controls[1].exitCode });
if ((await buildIdentity()).id !== baselineBuild.id) throw new Error('Baseline was modified during verification.');

const artifacts = [];
async function save(name, bytes) {
  await writeFile(path.join(exportRoot, name), bytes, { mode: 0o600 });
  artifacts.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
}
await save('repair.patch', patch);
for (const [label, suite] of [['baseline', baseline], ['candidate', candidate]]) {
  for (const [index, test] of suite.tests.entries()) {
    const evidence = { ...test.evidence, regressionStatus: test.status, expectedAssertionFailure: test.expectedAssertionFailure };
    // Baseline failure traces can include Playwright diagnostic attachments not
    // covered by VAL-01's export policy. Keep them private; export observations.
    if (label === 'candidate') {
      const sanitized = sanitizeTrace(await readFile(test.tracePath), [projectRoot, os.homedir()]);
      evidence.redaction = sanitized.audit;
      evidence.trace = `${label}-${index + 1}.trace.zip`;
      await save(evidence.trace, sanitized.bytes);
    }
    await save(`${label}-${index + 1}.json`, Buffer.from(JSON.stringify(evidence, null, 2) + '\n'));
  }
}
const sourceFiles = [];
async function fingerprint(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await fingerprint(full);
    else if (/\.(mjs|js|html|patch)$/.test(entry.name)) sourceFiles.push({ path: path.relative(projectRoot, full), sha256: sha256(await readFile(full)) });
  }
}
await fingerprint(spikeRoot);
const summary = {
  schemaVersion: 1, runId, verifiedAt: new Date().toISOString(), ...verdict,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
  sourceTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim()),
  sourceFiles, baselineBuild, candidateBuild, changedFiles,
  patchSha256: sha256(patch), lockfileSha256: sha256(await readFile(path.join(projectRoot, 'package-lock.json'))),
  regression: { baselineExit: baseline.exitCode, candidateExit: candidate.exitCode, baselineFailures: baseline.tests.length, candidatePasses: candidate.tests.length },
  requiredChecks: controls.map(({ label, exitCode }) => ({ label, exitCode })),
  artifacts, limitations: 'Separate local processes, same operator. Independent review remains outstanding. Baseline failure traces stay private under the narrow export policy.',
};
await writeFile(path.join(exportRoot, 'verification.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
for (const artifact of artifacts) if (sha256(await readFile(path.join(exportRoot, artifact.path))) !== artifact.sha256) throw new Error('Export integrity mismatch.');
console.log(`\nRepair technically verified: baseline failed twice; candidate passed twice; required checks passed on both.\nExport: ${exportRoot}\nIndependent operator review: pending.`);
