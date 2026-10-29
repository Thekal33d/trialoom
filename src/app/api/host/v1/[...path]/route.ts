import { AppError } from '@/domain/errors';
import { uuid } from '@/domain/schemas';
import { bearerToken } from '@/server/agents';
import { getPool } from '@/server/database';
import { handleApi, json, limitRequest, readJson } from '@/server/http';
import { authenticateHost, hostContract, hostRunView, recordEgress } from '@/server/isolation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The witness API. A runner host reports what its egress proxy allowed and
 * denied, under a credential no agent and no run grant ever holds. It is a
 * separate surface on purpose: an agent taken over inside the sandbox must not
 * be able to write its own alibi, and a host cannot claim work or submit
 * evidence from here.
 */
async function handler(request: Request) {
  return handleApi(
    request,
    async () => {
      const parts = new URL(request.url).pathname.replace('/api/host/v1/', '').split('/');
      const method = request.method;
      const pool = getPool();
      await limitRequest('host', 'global', 1200);
      if (parts[0] === 'contract' && parts.length === 1 && method === 'GET')
        return json({ contract: hostContract });
      const session = await authenticateHost(pool, bearerToken(request));
      await limitRequest('host', session.host.id, 600);
      if (parts[0] === 'runs' && parts.length === 2 && method === 'GET')
        return json(await hostRunView(pool, session, uuid.parse(parts[1])));
      if (parts[0] === 'runs' && parts.length === 3 && parts[2] === 'egress' && method === 'POST')
        return json(
          await recordEgress(pool, session, uuid.parse(parts[1]), await readJson(request)),
          201,
        );
      throw new AppError('NOT_FOUND', 'This host action is not available.', 404);
    },
    { requireSameOrigin: false },
  );
}
export const GET = handler;
export const POST = handler;
