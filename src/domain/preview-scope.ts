/** Exact, credential-free GET resources. Never interpret prefixes or wildcards. */
export function exactReadUrl(value: string) {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.href !== value ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    !/[a-z]/.test(url.hostname) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.')
  )
    throw new Error('READ_URL_INVALID');
  return { origin: url.origin, path: url.pathname + url.search };
}

export function dependencyScope(input: {
  primaryOrigin: string;
  origins: string[];
  readUrls: string[];
  blockedOrigins: string[];
}) {
  if (input.origins.length > 7 || input.readUrls.length > 12 || input.blockedOrigins.length > 7)
    throw new Error('DEPENDENCY_SCOPE_INVALID');
  const origins = new Set([input.primaryOrigin, ...input.origins]);
  const blocked = new Set(input.blockedOrigins);
  if (
    origins.size !== input.origins.length + 1 ||
    blocked.size !== input.blockedOrigins.length ||
    new Set(input.readUrls).size !== input.readUrls.length
  )
    throw new Error('DEPENDENCY_SCOPE_INVALID');
  const rules = new Map<string, { method: 'GET'; path: string }[]>();
  for (const value of input.readUrls) {
    const { origin, path } = exactReadUrl(value);
    if (origins.has(origin)) throw new Error('DEPENDENCY_SCOPE_OVERLAP');
    const paths = rules.get(origin) ?? [];
    paths.push({ method: 'GET', path });
    rules.set(origin, paths);
  }
  for (const origin of rules.keys()) origins.add(origin);
  if (origins.size > 8 || [...blocked].some((origin) => origins.has(origin)))
    throw new Error('DEPENDENCY_SCOPE_OVERLAP');
  return {
    dependencies: [...origins]
      .filter((origin) => origin !== input.primaryOrigin)
      .map((origin) => {
        const requests = rules.get(origin);
        return { origin, ...(requests ? { requests } : {}) };
      }),
    blockedOrigins: [...blocked],
  };
}
