/**
 * Raw evidence is private. Nothing becomes visible to a reviewer or a builder
 * until a redacted derivative exists and a second scan of that derivative finds
 * nothing left. This is a declared text policy for known secret shapes, not a
 * general customer-data sanitizer: binary and archived evidence cannot be
 * cleaned here and stays private instead of being shared unchecked.
 */
export const redactionPolicy = 'text-secrets-v1';

// Value-capturing patterns skip an existing placeholder, including one the
// prefix could reach by backtracking, so verifying a redacted copy never
// re-flags the replacement it just wrote.
const kept = '(?!\\s*\\[REDACTED)';
const rules: { name: string; pattern: RegExp; keepPrefix?: boolean }[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'authorization_header',
    pattern: new RegExp(`((?:proxy-)?authorization["']?\\s*[:=]\\s*["']?)${kept}[^"'\\n,}]+`, 'gi'),
    keepPrefix: true,
  },
  {
    name: 'cookie_header',
    pattern: new RegExp(`((?:set-)?cookie["']?\\s*[:=]\\s*["']?)${kept}[^"'\\n}]+`, 'gi'),
    keepPrefix: true,
  },
  {
    name: 'secret_field',
    pattern: new RegExp(
      `(["']?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|mnemonic|seed[_-]?phrase)["']?\\s*[:=]\\s*["']?)${kept}[^"'\\n,}&]+`,
      'gi',
    ),
    keepPrefix: true,
  },
  { name: 'run_grant', pattern: /\btrun_[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { name: 'hex_key', pattern: /\b0x[0-9a-fA-F]{64}\b/g },
  { name: 'credentialed_url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'home_path', pattern: /\/(?:Users|home)\/[^/\s"']+/g },
];

function literalOccurrences(text: string, secret: string) {
  return secret.length >= 8 ? text.split(secret).length - 1 : 0;
}

export function scanText(text: string, secrets: string[] = []): Record<string, number> {
  const findings: Record<string, number> = {};
  for (const rule of rules) {
    const count = text.match(rule.pattern)?.length ?? 0;
    if (count) findings[rule.name] = count;
  }
  const literal = secrets.reduce((sum, secret) => sum + literalOccurrences(text, secret), 0);
  if (literal) findings.known_secret = literal;
  return findings;
}

/** Returns the redacted text and what each rule replaced, for the record. */
export function redactText(text: string, secrets: string[] = []) {
  let output = text;
  const findings: Record<string, number> = {};
  for (const secret of secrets) {
    const count = literalOccurrences(output, secret);
    if (count) {
      findings.known_secret = (findings.known_secret ?? 0) + count;
      output = output.split(secret).join('[REDACTED:known_secret]');
    }
  }
  for (const rule of rules) {
    let replaced = 0;
    output = output.replace(rule.pattern, (_match, prefix: string | undefined) => {
      replaced += 1;
      return rule.keepPrefix ? `${prefix ?? ''}[REDACTED:${rule.name}]` : `[REDACTED:${rule.name}]`;
    });
    if (replaced) findings[rule.name] = (findings[rule.name] ?? 0) + replaced;
  }
  return { text: output, findings };
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
