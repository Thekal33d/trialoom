import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import { getPool } from '../database.ts';

export function authSettings(env: Record<string, string | undefined> = process.env) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-'))
    throw new Error('Authentication secret is not configured');
  const url = new URL(env.BETTER_AUTH_URL ?? '');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid authentication origin');
  return { secret, baseURL: url.origin };
}
export function createAuth(pool: Pool, settings: { secret: string; baseURL: string }) {
  return betterAuth({
    appName: 'Trialoom',
    ...settings,
    database: pool,
    trustedOrigins: [settings.baseURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: { modelName: 'auth_user' },
    session: {
      modelName: 'auth_session',
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    rateLimit: { enabled: false }, // HTTP entry point applies atomic database limits without trusting forwarded IP headers.
    advanced: {
      useSecureCookies: settings.baseURL.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    logger: { disabled: true },
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  instance ??= createAuth(getPool(), authSettings());
  return instance;
}
