import { AppError } from '@/domain/errors';
import { authSettings } from '@/server/auth/config';
import { getPool } from '@/server/database';
import { handleApi, json, limitRequest, readJson } from '@/server/http';
import {
  completeSignup,
  inspectSignup,
  requestSignup,
  requirePublicSignup,
  signupRequestSchema,
} from '@/server/signup';
import { signupMailer } from '@/server/signup-mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleApi(request, async () => {
    requirePublicSignup();
    const action = new URL(request.url).pathname.split('/').at(-1);
    if (!['request', 'inspect', 'complete'].includes(action ?? ''))
      throw new AppError('NOT_FOUND', 'Signup action is not available.', 404);
    await limitRequest('signup', 'global', 30);
    const body = await readJson(request, 4096);
    const pool = getPool();
    if (action === 'request') {
      const data = signupRequestSchema.parse(body);
      await limitRequest('signup-email', data.email, 3, 900);
      await limitRequest('signup-email-daily', 'global', 200, 86400);
      const send = signupMailer();
      return json(await requestSignup(pool, data, authSettings().baseURL, send), 202);
    }
    if (action === 'inspect')
      return json(await inspectSignup(pool, (body as { token?: unknown })?.token));
    await limitRequest('signup-complete', 'global', 10);
    return json(await completeSignup(pool, body), 201);
  });
}
