import { AppError } from '@/domain/errors';
import { idempotencyKeySchema } from '@/domain/schemas';
import {
  authenticateAgent,
  bearerToken,
  listEligibleWork,
  requireScope,
  withIdempotency,
} from '@/server/agents';
import { getPool } from '@/server/database';
import { handleApi, json, limitRequest, readJson } from '@/server/http';
import { qualificationStatus, recordAttempt } from '@/server/qualification';

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
      if (parts[0] === 'assignments')
        throw new AppError(
          'ASSIGNMENTS_UNAVAILABLE',
          'Claims, leases, heartbeats, and evidence submission are not implemented. They require the campaign ledger and atomic reservations.',
          501,
        );
      throw new AppError('NOT_FOUND', 'This agent action is not available.', 404);
    },
    { requireSameOrigin: false },
  );
}
export const GET = handler;
export const POST = handler;
