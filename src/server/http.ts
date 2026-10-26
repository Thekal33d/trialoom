import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors.ts';
import type { Actor } from './access.ts';
import { authSettings, getAuth } from './auth/config.ts';
import { getPool } from './database.ts';
export const privateHeaders = {
  'Cache-Control': 'no-store',
  Vary: 'Cookie',
  'X-Robots-Tag': 'noindex',
};
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders });
}
export function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== authSettings().baseURL)
    throw new AppError('ORIGIN_REJECTED', 'Request origin is not allowed.', 403);
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new AppError('JSON_REQUIRED', 'Send an application/json request.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('BODY_REQUIRED', 'Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new AppError('BODY_TOO_LARGE', 'Request exceeds 32 KiB.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'Request JSON is invalid.');
  }
}
export async function sessionActor(request: Request): Promise<Actor | null> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session
    ? { id: session.user.id, email: session.user.email, name: session.user.name }
    : null;
}
export async function limitRequest(purpose: string, identity: string, maximum: number) {
  const key = createHash('sha256').update(`${purpose}:${identity}`).digest('hex');
  const { rows } = await getPool().query(
    `INSERT INTO request_limits (key,count,resets_at) VALUES ($1,1,clock_timestamp()+interval '1 minute')
    ON CONFLICT (key) DO UPDATE SET count=CASE WHEN request_limits.resets_at<=clock_timestamp() THEN 1 ELSE request_limits.count+1 END,
    resets_at=CASE WHEN request_limits.resets_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE request_limits.resets_at END
    RETURNING count`,
    [key],
  );
  if (rows[0].count > maximum)
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a minute.', 429);
}
export async function handleApi(request: Request, handler: () => Promise<Response>) {
  const requestId = randomUUID();
  try {
    if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
    const response = await handler();
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    let status = 503,
      code = 'SERVICE_UNAVAILABLE',
      message = 'This service is temporarily unavailable.';
    if (error instanceof AppError) {
      ({ status, code } = error);
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message = error.issues
        .map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`)
        .slice(0, 5)
        .join(' ');
    } else if ((error as { code?: string })?.code === '23505') {
      status = 409;
      code = 'ALREADY_EXISTS';
      message = 'This record already exists.';
    } else console.error(JSON.stringify({ event: 'request.failed', requestId }));
    return Response.json(
      { error: { code, message, requestId } },
      { status, headers: { ...privateHeaders, 'X-Request-Id': requestId } },
    );
  }
}
