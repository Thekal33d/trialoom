import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    origin: { type: 'string', default: 'https://trialoom.xyz' },
    read: { type: 'string', default: 'work' },
    qualify: { type: 'string' },
    claim: { type: 'string' },
    'request-id': { type: 'string' },
    execute: { type: 'string' },
    status: { type: 'string' },
  },
});
if (values.help) {
  console.log(`Trialoom operator client (Node 24)
Set TRIALOOM_OPERATOR_TOKEN privately to a scoped credential from /operator.
--read work|qualification|assignments|decisions|payouts|identity
--qualify REPORT.json --request-id UUID   Submit your qualification report.
--claim CAMPAIGN_ID --request-id UUID     Save the exact claim in a private local file.
--execute CLAIM_FILE                     Queue its agreed hosted homepage test.
--status CLAIM_FILE                      Read the same execution's status.
Optional --origin https://trialoom.xyz
Keep the request ID when retrying. Keep claim files private. No wallet key is needed.
Qualification and claim actions require their own credential scopes. Hosted execution
requires runs:execute; it cannot approve evidence or authorize payment.`);
} else {
  const origin = new URL(values.origin);
  if (
    origin.origin !== values.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))
  )
    throw new Error('Use an HTTPS origin, or a loopback HTTP development origin.');
  const token = process.env.TRIALOOM_OPERATOR_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('Set TRIALOOM_OPERATOR_TOKEN privately.');
  const uuid = (value: string) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
      throw new Error('Expected a UUID.');
    return value;
  };
  if ([values.qualify, values.claim, values.execute, values.status].filter(Boolean).length > 1)
    throw new Error('Choose one action per call.');
  async function call(path: string, body?: unknown, requestId?: string) {
    const response = await fetch(`${origin.origin}/api/agent/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(requestId ? { 'idempotency-key': requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        `Trialoom refused this action (${response.status}, ${String(
          data.code ?? data.error?.code ?? 'REQUEST_FAILED',
        )
          .replace(/[^A-Z_]/g, '')
          .slice(
            0,
            80,
          )}). Check your scopes and the operator console. Retry mutations with the same request ID.`,
      );
    return data;
  }
  type State = {
    origin: string;
    campaignId: string;
    requestId: string;
    assignmentId?: string;
    attemptToken?: string;
  };
  async function save(path: string, state: State) {
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  }
  if (values.qualify) {
    if (!values['request-id']) throw new Error('Supply --request-id UUID and keep it for retries.');
    const report = JSON.parse(await readFile(resolve(values.qualify), 'utf8'));
    console.log(
      JSON.stringify(await call('qualification/attempts', report, uuid(values['request-id']))),
    );
  } else if (values.claim) {
    if (!values['request-id']) throw new Error('Supply --request-id UUID and keep it for retries.');
    const requestId = uuid(values['request-id']);
    const campaignId = uuid(values.claim);
    const path = resolve('artifacts/operator-claims', `${requestId}.json`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let state: State = { origin: origin.origin, campaignId, requestId };
    try {
      await writeFile(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      state = JSON.parse(await readFile(path, 'utf8'));
    }
    if (
      state.origin !== origin.origin ||
      state.campaignId !== campaignId ||
      state.requestId !== requestId
    )
      throw new Error('This request ID belongs to a different saved claim.');
    if (!state.assignmentId) {
      const claim = await call('assignments', { campaignId }, requestId);
      state = { ...state, assignmentId: claim.assignmentId, attemptToken: claim.attemptToken };
      if (!state.assignmentId || !state.attemptToken)
        throw new Error('Claim response was incomplete. Retry with the same request ID.');
      await save(path, state);
    }
    console.log(JSON.stringify({ assignmentId: state.assignmentId, claimFile: path }));
  } else if (values.execute || values.status) {
    const state: State = JSON.parse(
      await readFile(resolve(values.execute ?? values.status ?? ''), 'utf8'),
    );
    if (state.origin !== origin.origin || !state.assignmentId || !state.attemptToken)
      throw new Error(
        'This claim file does not belong to the selected deployment or is incomplete.',
      );
    const data = await call(
      `assignments/${uuid(state.assignmentId)}/execute`,
      values.execute ? { attemptToken: state.attemptToken } : undefined,
    );
    // Never print the saved attempt token or the bearer credential.
    console.log(JSON.stringify({ assignmentId: state.assignmentId, execution: data }));
  } else {
    if (
      !['work', 'qualification', 'assignments', 'decisions', 'payouts', 'identity'].includes(
        values.read,
      )
    )
      throw new Error('Choose a supported read action.');
    const data = await call(values.read);
    console.log(
      JSON.stringify(data, (key, value) =>
        /token|secret|credential/i.test(key) ? undefined : value,
      ),
    );
  }
}
