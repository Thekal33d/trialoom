import type { TermsInput } from '@/domain/schemas';
export type WorkspaceSummary = {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'reviewer' | 'operator';
};
export type ProjectSummary = {
  id: string;
  name: string;
  target_url: string;
  environment: string;
  created_at: string;
};
export type BuildRecord = {
  id: string;
  revision: string;
  fixture_version: string;
  target_url: string;
  created_at: string;
};
export type CampaignRecord = {
  id: string;
  name: string;
  status: 'draft' | 'open' | 'paused' | 'draining' | 'cancelled' | 'completed';
  latest_version: number;
};
export type TermsRecord = {
  id: string;
  campaign_id: string;
  build_id: string;
  version: number;
  document: Omit<TermsInput, 'expectedVersion' | 'scopeApproved'> & {
    currency: { symbol: string; decimals: number; chainId: number; address: string };
  };
  content_hash: string;
  created_at: string;
};
export type ProjectDetail = {
  project: ProjectSummary & {
    authorized_origin: string;
    authorized_at: string;
    repository_url: string | null;
  };
  builds: BuildRecord[];
  campaigns: CampaignRecord[];
  terms: TermsRecord[];
};
export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? data.message ?? 'Unable to complete this request.');
  return data;
}
export function field(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim();
}
