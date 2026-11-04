import { getAuth } from '@/server/auth/config';
import { handleApi, json, limitRequest, privateHeaders, readJson } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  return handleApi(request, async () => {
    const endpoint = new URL(request.url).pathname.replace('/api/auth/', '');
    if (
      !(
        (request.method === 'GET' && endpoint === 'get-session') ||
        (request.method === 'POST' &&
          ['sign-in/email', 'sign-out', 'wallet/challenge', 'wallet/verify'].includes(endpoint))
      )
    )
      return json(
        { error: { code: 'NOT_FOUND', message: 'Authentication action is not available.' } },
        404,
      );
    let forwarded = request;
    if (request.method === 'POST') {
      await limitRequest('auth', 'global', 200);
      const body = (await readJson(request)) as {
        email?: unknown;
        address?: unknown;
        id?: unknown;
      };
      if (endpoint.startsWith('wallet/'))
        await limitRequest(
          endpoint,
          String(body?.address ?? body?.id ?? '')
            .toLowerCase()
            .slice(0, 64),
          10,
        );
      if (endpoint === 'sign-in/email')
        await limitRequest(
          'sign-in',
          String(body?.email ?? '')
            .toLowerCase()
            .slice(0, 254),
          10,
        );
      forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
      });
    }
    const result = await getAuth().handler(forwarded);
    const headers = new Headers(result.headers);
    for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
    return new Response(result.body, { status: result.status, headers });
  });
}
export const GET = handler;
export const POST = handler;
