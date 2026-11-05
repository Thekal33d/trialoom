import { createHash, randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { uuid } from '../src/domain/schemas.ts';
import { createPool, databaseUrl, transaction } from '../src/server/database.ts';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    workspace: { type: 'string' },
    owner: { type: 'string' },
    name: { type: 'string' },
    output: { type: 'string' },
    'host-check-passed': { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`Administrative managed-runner enrollment (requires direct database access).
Run the native gVisor host check on the dedicated Linux host first. Then:
node --env-file=.env scripts/register-managed-runner.ts --workspace UUID --owner USER_ID --name HOST_NAME --output /private/path/host.env --host-check-passed
Writes the host credential once with mode 0600. Copy it privately into the runner's
environment; never put it in the web service. The shared dispatch key, database URL,
S3 credentials and runner API origin are configured separately. No payment key belongs
on the browser host. Run the cloud setup only on an authorized dedicated server.`);
} else {
  if (
    !values['host-check-passed'] ||
    !values.workspace ||
    !values.owner ||
    !values.name ||
    !values.output ||
    values.name.length > 80
  )
    throw new Error(
      'Read --help and supply every enrollment argument after the native host check passes.',
    );
  const workspace = uuid.parse(values.workspace);
  const output = resolve(values.output);
  const file = await open(output, 'wx', 0o600);
  const pool = createPool(databaseUrl());
  let committed = false;
  try {
    const secret = `trh_${randomBytes(32).toString('base64url')}`;
    const hostId = await transaction(pool, async (db) => {
      const owner = await db.query(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",
        [workspace, values.owner],
      );
      if (!owner.rowCount)
        throw new Error('The selected user must own the administrative workspace.');
      const result = await db.query(
        `INSERT INTO runner_hosts
        (name,contract_version,sandbox,egress_enforced,ephemeral_filesystem,isolation_level,credential_hash,registered_by,workspace_id,platform_managed)
        VALUES ($1,'runner-host-v1','gvisor',true,true,'witnessed',$2,$3,$4,true) RETURNING id`,
        [values.name, createHash('sha256').update(secret).digest('hex'), values.owner, workspace],
      );
      await file.writeFile(`TRIALOOM_HOST_CREDENTIAL=${secret}\n`);
      await file.sync();
      return result.rows[0].id;
    });
    committed = true;
    console.log(JSON.stringify({ event: 'runner.enrolled', hostId, credentialFile: output }));
  } finally {
    await file.close();
    await pool.end();
    if (!committed) await rm(output, { force: true });
  }
}
