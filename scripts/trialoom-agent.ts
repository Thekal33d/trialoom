import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { trialoomAgent } from '../src/client/trialoom-agent.ts';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    origin: { type: 'string', default: 'https://trialoom.xyz' },
    workspace: { type: 'string' },
    sample: { type: 'boolean' },
    project: { type: 'string' },
    website: { type: 'string' },
    authorized: { type: 'boolean' },
    'request-id': { type: 'string' },
    cancel: { type: 'string' },
  },
});
if (values.help) {
  console.log(
    `Trialoom wallet agent client\n\nSet TRIALOOM_CLIENT_PRIVATE_KEY in your local environment. Never put keys in arguments or chat.\n\nnode scripts/trialoom-agent.ts [--origin https://trialoom.xyz] [--workspace ID]\n  No action: sign in and read test status.\n  --sample --request-id UUID: request the prepared sample.\n  --project ID --authorized --request-id UUID: test an enabled website you may test.\n  --website https://your-app --authorized: save a website; does not run it.\n  --cancel ID: cancel your test.\n\nKeep the printed request-id when retrying a test request after a network error.\nWallet proof grants workspace access only. The client never signs payments.`,
  );
} else {
  const key = process.env.TRIALOOM_CLIENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error('Set TRIALOOM_CLIENT_PRIVATE_KEY in your local environment.');
  if ([values.sample, values.project, values.website, values.cancel].filter(Boolean).length > 1)
    throw new Error('Choose one action per call.');
  const client = trialoomAgent(values.origin, privateKeyToAccount(key as `0x${string}`));
  try {
    const connection = await client.connect(values.workspace);
    console.log(
      JSON.stringify({ wallet: connection.address, workspaceId: connection.workspaceId }),
    );
    if (values.website)
      console.log(JSON.stringify(await client.addWebsite(values.website, !!values.authorized)));
    else if (values.cancel) console.log(JSON.stringify(await client.cancel(values.cancel)));
    else if (values.sample || values.project) {
      const requestId = values['request-id'] ?? randomUUID();
      console.log(JSON.stringify({ requestId }));
      console.log(
        JSON.stringify(
          await client.start({
            projectId: values.project,
            permission: !!values.authorized,
            requestId,
          }),
        ),
      );
    } else console.log(JSON.stringify(connection.status));
  } finally {
    await client.close().catch(() => {});
  }
}
