import { AppError } from '../domain/errors.ts';
import type { SignupMailer } from './signup.ts';

/** Provider keys and capability links never enter client responses or logs. */
export function signupMailer(
  env: Record<string, string | undefined> = process.env,
  transport: typeof fetch = fetch,
): SignupMailer {
  const key = env.RESEND_API_KEY;
  const from = env.TRIALOOM_EMAIL_FROM;
  if (!key || !from || /[\r\n]/.test(from))
    throw new AppError(
      'SIGNUP_EMAIL_UNAVAILABLE',
      'Signup email is not available yet. Please try again later.',
      503,
    );
  return async ({ id, email, url }) => {
    try {
      const response = await transport('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `signup/${id}`,
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Create your free Trialoom workspace',
          text: `Confirm your email and choose your password:\n\n${url}\n\nThis link expires in 30 minutes and can be used once. If you already have a Trialoom account, sign in instead. If you did not request this email, you can ignore it.`,
        }),
      });
      // Do not surface provider response bodies, keys, addresses or links.
      await response.body?.cancel();
      if (!response.ok) throw new Error('Mail provider refused');
    } catch {
      throw new AppError(
        'SIGNUP_EMAIL_UNAVAILABLE',
        'We could not confirm email delivery. Check your inbox, or request a new link in a few minutes.',
        503,
      );
    }
  };
}
