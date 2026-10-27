import { AppError } from '@/domain/errors';
import { idempotencyKeySchema, uuid } from '@/domain/schemas';
import {
  authenticateAgent,
  bearerToken,
  listEligibleWork,
  requireScope,
  withIdempotency,
} from '@/server/agents';
import {
  claimAssignment,
  heartbeatAssignment,
  operatorAssignments,
  releaseAssignment,
} from '@/server/assignments';
import { getPool } from '@/server/database';
import { storeArtifact, submitEvidence } from '@/server/evidence';
import { handleApi, json, limitRequest, readBytes, readJson } from '@/server/http';
import { qualificationStatus, recordAttempt } from '@/server/qualification';
import {
  abandonRun,
  authenticateRun,
  issueRun,
  prepareRun,
  runLimits,
  runView,
} from '@/server/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request: Request) {
  return handleApi(
    request,
    async () => {
      const route = new URL(request.url).pathname.replace('/api/agent/v1/', '');
      const parts = route.split('/');
      const method = request.method;
      const pool = getPool();
      await limitRequest('agent', 'global', 1200);
      // A run grant is a separate, narrower credential: it reaches these routes
      // and nothing else, and no agent credential can use them.
      if (parts[0] === 'runs' && parts.length >= 2 && parts[2] !== 'abandon') {
        const run = await authenticateRun(pool, bearerToken(request));
        if (uuid.parse(parts[1]) !== run.run.id)
          throw new AppError('RUN_MISMATCH', 'This grant belongs to a different run.', 403);
        await limitRequest('run', run.run.id, 240);
        if (parts.length === 2 && method === 'GET') return json(runView(run.run));
        if (parts.length === 3 && method === 'POST' && parts[2] === 'artifacts') {
          const query = new URL(request.url).searchParams;
          const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim();
          const bytes = await readBytes(request, runLimits.maxArtifactBytes + 1);
          return json(
            await storeArtifact(
              pool,
              run,
              {
                name: query.get('name') ?? '',
                kind: query.get('kind') ?? '',
                sha256: query.get('sha256') ?? '',
              },
              mediaType,
              bytes,
            ),
            201,
          );
        }
        if (parts.length === 3 && method === 'POST' && parts[2] === 'evidence')
          return json(await submitEvidence(pool, run, await readJson(request, 262144)), 201);
        throw new AppError('NOT_FOUND', 'This run action is not available.', 404);
      }
      const session = await authenticateAgent(pool, bearerToken(request));
      await limitRequest('agent', session.credential.id, 120);
      if (route === 'identity' && method === 'GET') {
        requireScope(session, 'operator:read');
        const wallets = (
          await pool.query(
            `SELECT chain_id,address,account_type,verified_at,payout_designated_at
            FROM operator_wallets WHERE operator_id=$1 AND revoked_at IS NULL ORDER BY verified_at`,
            [session.operator.id],
          )
        ).rows;
        return json({
          operator: session.operator,
          credential: session.credential,
          wallets,
          // FR07: a credential never carries payout signing authority.
          payoutSigning: 'never_delegated',
        });
      }
      if (route === 'qualification' && method === 'GET') {
        requireScope(session, 'qualification:submit');
        return json(await qualificationStatus(pool, session.operator.id));
      }
      if (route === 'qualification/attempts' && method === 'POST') {
        requireScope(session, 'qualification:submit');
        const key = idempotencyKeySchema.parse(request.headers.get('idempotency-key') ?? '');
        const body = await readJson(request);
        const result = await withIdempotency(pool, session, route, body, key, (db) =>
          recordAttempt(db, session.operator, session.credential.id, body),
        );
        return json(
          { ...result.body, replayed: result.replayed },
          result.replayed ? 200 : result.status,
        );
      }
      if (route === 'work' && method === 'GET') {
        requireScope(session, 'work:read');
        return json(await listEligibleWork(pool, session));
      }
      if (
        parts[0] === 'runs' &&
        parts.length === 3 &&
        parts[2] === 'abandon' &&
        method === 'POST'
      ) {
        requireScope(session, 'runs:execute');
        return json(await abandonRun(pool, session, uuid.parse(parts[1]), await readJson(request)));
      }
      if (parts[0] === 'assignments') {
        if (parts.length === 1 && method === 'GET') {
          requireScope(session, 'assignments:read');
          return json(await operatorAssignments(pool, session.operator.id));
        }
        if (parts.length === 1 && method === 'POST') {
          requireScope(session, 'assignments:claim');
          const key = idempotencyKeySchema.parse(request.headers.get('idempotency-key') ?? '');
          const body = await readJson(request);
          const result = await withIdempotency(pool, session, route, body, key, (db) =>
            claimAssignment(db, session, body),
          );
          return json(
            { ...result.body, replayed: result.replayed },
            result.replayed ? 200 : result.status,
          );
        }
        if (parts.length === 3 && method === 'POST') {
          const assignmentId = uuid.parse(parts[1]);
          const body = await readJson(request);
          if (parts[2] === 'runs') {
            requireScope(session, 'runs:execute');
            const key = idempotencyKeySchema.parse(request.headers.get('idempotency-key') ?? '');
            // The target check runs first; the grant is issued inside the
            // idempotency transaction so a retry cannot leave an orphan run.
            const prepared = await prepareRun(pool, session, assignmentId, body);
            const result = await withIdempotency(pool, session, route, body, key, (db) =>
              issueRun(db, session, prepared),
            );
            return json(
              { ...result.body, replayed: result.replayed },
              result.replayed ? 200 : result.status,
            );
          }
          requireScope(session, 'assignments:claim');
          if (parts[2] === 'heartbeat')
            return json(await heartbeatAssignment(pool, session, assignmentId, body));
          if (parts[2] === 'release')
            return json(await releaseAssignment(pool, session, assignmentId, body));
        }
        throw new AppError(
          'ASSIGNMENTS_UNAVAILABLE',
          'Acceptance decisions and payouts are not implemented. They require the review and settlement work.',
          501,
        );
      }
      throw new AppError('NOT_FOUND', 'This agent action is not available.', 404);
    },
    { requireSameOrigin: false },
  );
}
export const GET = handler;
export const POST = handler;
