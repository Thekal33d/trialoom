import { AppError } from '@/domain/errors';
import { uuid } from '@/domain/schemas';
import { listEligibleWork } from '@/server/agents';
import {
  authorizeMore,
  campaignLedger,
  operatorAssignments,
  publishCampaign,
  setCampaignStatus,
} from '@/server/assignments';
import { campaignAttentionRecord, workspaceAttention } from '@/server/attention';
import {
  registerAuthority,
  revokeAuthority,
  topUpAuthority,
  unreadableAuthority,
  verifyAuthority,
  workspaceAuthorities,
} from '@/server/authority';
import { getPool, transaction } from '@/server/database';
import {
  decideDiscovery,
  decideDuplicate,
  decideExecution,
  decideSeverity,
  operatorDecisions,
  resolveAppeal,
} from '@/server/decisions';
import { campaignActivity, noteReviewOpened } from '@/server/events';
import {
  campaignPayoutRecord,
  campaignRepairRecord,
  campaignResourceRecord,
  campaignReview,
  campaignSubmissions,
  readArtifact,
  readReplay,
} from '@/server/evidence';
import { campaignExport } from '@/server/exports';
import { cancelFreeTest, freeTestsView, requestFreeTest } from '@/server/free-tests';
import {
  handleApi,
  json,
  limitRequest,
  privateHeaders,
  readJson,
  sessionActor,
} from '@/server/http';
import {
  acceptInvitation,
  createInvitation,
  inspectInvitation,
  removeMember,
  revokeInvitation,
} from '@/server/invitations';
import { registerHost, revokeHost, workspaceHosts } from '@/server/isolation';
import { enableMarketplace } from '@/server/marketplace';
import { pilotReadiness } from '@/server/metrics';
import { registerEndpoint, revokeEndpoint, workspaceNotices } from '@/server/notices';
import {
  createCredential,
  issueWalletChallenge,
  operatorOverview,
  proveWallet,
  registerOperator,
  requireOperator,
  revokeCredential,
  revokeWallet,
} from '@/server/operators';
import { operatorPayouts } from '@/server/payables';
import {
  addBuild,
  createCampaign,
  createProject,
  listProjects,
  projectDetail,
  reviseTerms,
} from '@/server/projects';
import { qualificationStatus } from '@/server/qualification';
import { redactionPolicy } from '@/server/redaction';
import { configuredPayments } from '@/server/remesso';
import { decideQuote, proposeQuote } from '@/server/repairs';
import {
  issueTargetChallenge,
  revokeTargetVerification,
  targetVerificationView,
  verifyTargetChallenge,
} from '@/server/target-verification';
import { listWorkspaces, workspaceAccess } from '@/server/workspaces';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  return handleApi(request, async () => {
    const parts = new URL(request.url).pathname.replace('/api/v1/', '').split('/');
    const method = request.method,
      pool = getPool();
    if (
      parts[0] === 'invitations' &&
      parts.length === 2 &&
      method === 'POST' &&
      ['inspect', 'accept'].includes(parts[1])
    ) {
      await limitRequest('invitation', 'global', 60);
      const body = (await readJson(request)) as { token?: unknown };
      if (parts[1] === 'inspect') return json(await inspectInvitation(pool, body?.token));
      return json(await acceptInvitation(pool, body, await sessionActor(request)), 201);
    }
    if (!['me', 'workspaces', 'operator'].includes(parts[0]))
      throw new AppError('NOT_FOUND', 'This action is not available.', 404);
    const actor = await sessionActor(request);
    if (!actor) throw new AppError('AUTH_REQUIRED', 'Sign in to continue.', 401);
    if (method !== 'GET') await limitRequest('mutation', actor.id, 100);
    if (parts.length === 1 && parts[0] === 'me' && method === 'GET') return json({ user: actor });
    if (parts[0] === 'operator') {
      if (parts.length === 1 && method === 'GET') return json(await operatorOverview(pool, actor));
      if (
        parts.length === 2 &&
        method === 'GET' &&
        ['qualification', 'work', 'assignments', 'decisions', 'payouts'].includes(parts[1])
      ) {
        const operator = await transaction(pool, (db) => requireOperator(db, actor));
        if (parts[1] === 'qualification') return json(await qualificationStatus(pool, operator.id));
        if (parts[1] === 'work')
          return json(await listEligibleWork(pool, { operatorId: operator.id, userId: actor.id }));
        if (parts[1] === 'decisions') return json(await operatorDecisions(pool, operator.id));
        if (parts[1] === 'payouts') return json(await operatorPayouts(pool, operator.id));
        return json(await operatorAssignments(pool, operator.id));
      }
      if (parts.length === 1 && method === 'POST')
        return json(await registerOperator(pool, actor, await readJson(request)), 201);
      if (parts.length === 2 && parts[1] === 'wallet-challenges' && method === 'POST')
        return json(await issueWalletChallenge(pool, actor, await readJson(request)), 201);
      if (parts.length === 2 && parts[1] === 'wallets' && method === 'POST')
        return json(await proveWallet(pool, actor, await readJson(request)), 201);
      if (parts.length === 3 && parts[1] === 'wallets' && method === 'DELETE')
        return json(await revokeWallet(pool, actor, parts[2]));
      if (parts.length === 2 && parts[1] === 'credentials' && method === 'POST')
        return json(await createCredential(pool, actor, await readJson(request)), 201);
      if (parts.length === 3 && parts[1] === 'credentials' && method === 'DELETE')
        return json(await revokeCredential(pool, actor, parts[2]));
    }
    if (parts.length === 1 && parts[0] === 'workspaces' && method === 'GET')
      return json({ workspaces: await listWorkspaces(pool, actor) });
    if (parts[0] === 'workspaces' && parts.length >= 3) {
      const workspaceId = uuid.parse(parts[1]);
      if (parts.length === 3 && parts[2] === 'marketplace' && method === 'POST')
        return json(
          await enableMarketplace(pool, actor, workspaceId, await readJson(request, 1024)),
        );
      if (parts[2] === 'free-tests') {
        if (parts.length === 3 && method === 'GET')
          return json(await freeTestsView(pool, actor, workspaceId));
        if (parts.length === 3 && method === 'POST')
          return json(
            await requestFreeTest(pool, actor, workspaceId, await readJson(request, 4096)),
            201,
          );
        if (parts.length === 4 && method === 'DELETE')
          return json(await cancelFreeTest(pool, actor, workspaceId, parts[3]));
      }
      if (parts[2] === 'projects') {
        if (parts.length === 3 && method === 'GET')
          return json({ projects: await listProjects(pool, actor, workspaceId) });
        if (parts.length === 3 && method === 'POST')
          return json(await createProject(pool, actor, workspaceId, await readJson(request)), 201);
        if (parts.length >= 4) {
          const projectId = uuid.parse(parts[3]);
          if (parts.length === 5 && parts[4] === 'verification') {
            if (method === 'GET')
              return json(await targetVerificationView(pool, actor, workspaceId, projectId));
            if (method === 'POST')
              return json(await issueTargetChallenge(pool, actor, workspaceId, projectId), 201);
            if (method === 'DELETE')
              return json(await revokeTargetVerification(pool, actor, workspaceId, projectId));
          }
          if (
            parts.length === 6 &&
            parts[4] === 'verification' &&
            parts[5] === 'check' &&
            method === 'POST'
          )
            return json(
              await verifyTargetChallenge(
                pool,
                actor,
                workspaceId,
                projectId,
                await readJson(request, 1024),
              ),
            );
          if (parts.length === 4 && method === 'GET')
            return json(await projectDetail(pool, actor, workspaceId, projectId));
          if (parts.length === 5 && parts[4] === 'builds' && method === 'POST')
            return json(
              await addBuild(pool, actor, workspaceId, projectId, await readJson(request)),
              201,
            );
          if (parts.length === 5 && parts[4] === 'campaigns' && method === 'POST')
            return json(
              await createCampaign(pool, actor, workspaceId, projectId, await readJson(request)),
              201,
            );
          if (parts.length === 5 && parts[4] === 'repair-quotes' && method === 'POST')
            return json(
              await proposeQuote(pool, actor, workspaceId, projectId, await readJson(request)),
              201,
            );
          // Approving a quote is a spending decision, so it is its own step.
          if (parts.length === 6 && parts[4] === 'repair-quotes' && method === 'POST')
            return json(
              await decideQuote(
                pool,
                actor,
                workspaceId,
                projectId,
                parts[5],
                await readJson(request),
              ),
              201,
            );
          if (
            parts.length === 9 &&
            parts[4] === 'campaigns' &&
            parts[6] === 'submissions' &&
            parts[8] === 'replay' &&
            method === 'GET'
          )
            return json(
              await readReplay(pool, actor, workspaceId, projectId, uuid.parse(parts[5]), parts[7]),
            );
          if (
            parts.length === 8 &&
            parts[4] === 'campaigns' &&
            parts[6] === 'artifacts' &&
            method === 'GET'
          ) {
            const artifact = await readArtifact(
              pool,
              actor,
              workspaceId,
              projectId,
              uuid.parse(parts[5]),
              parts[7],
            );
            // Operator-supplied evidence is never rendered inline on this origin,
            // and only the verified redacted copy is served.
            return new Response(new Uint8Array(artifact.bytes), {
              headers: {
                ...privateHeaders,
                'Content-Type': artifact.mediaType,
                'Content-Disposition': `attachment; filename="redacted-${artifact.name}"`,
                'X-Content-Type-Options': 'nosniff',
                'X-Trialoom-Redaction': String(artifact.redaction.policy),
                'X-Trialoom-Artifact-Hash': artifact.sha256,
              },
            });
          }
          if (parts.length === 9 && parts[4] === 'campaigns' && method === 'POST') {
            const campaignId = uuid.parse(parts[5]);
            const subjectId = uuid.parse(parts[7]);
            const body = await readJson(request);
            if (parts[6] === 'assignments') {
              if (parts[8] === 'execution')
                return json(
                  await decideExecution(pool, actor, workspaceId, projectId, subjectId, body),
                  201,
                );
              if (parts[8] === 'appeal')
                return json(
                  await resolveAppeal(pool, actor, workspaceId, projectId, subjectId, body),
                  201,
                );
            }
            if (parts[6] === 'findings') {
              if (parts[8] === 'discovery')
                return json(
                  await decideDiscovery(pool, actor, workspaceId, projectId, subjectId, body),
                  201,
                );
              if (parts[8] === 'duplicate')
                return json(
                  await decideDuplicate(pool, actor, workspaceId, projectId, subjectId, body),
                  201,
                );
              if (parts[8] === 'severity')
                return json(
                  await decideSeverity(pool, actor, workspaceId, projectId, subjectId, body),
                  201,
                );
            }
            void campaignId;
          }
          if (parts.length === 7 && parts[4] === 'campaigns') {
            const campaignId = uuid.parse(parts[5]);
            if (parts[6] === 'ledger' && method === 'GET')
              return json(await campaignLedger(pool, actor, workspaceId, projectId, campaignId));
            if (parts[6] === 'submissions' && method === 'GET')
              return json(
                await campaignSubmissions(pool, actor, workspaceId, projectId, campaignId),
              );
            if (parts[6] === 'review' && method === 'GET')
              return json(await campaignReview(pool, actor, workspaceId, projectId, campaignId));
            if (parts[6] === 'payouts' && method === 'GET')
              return json(
                await campaignPayoutRecord(pool, actor, workspaceId, projectId, campaignId),
              );
            if (parts[6] === 'repairs' && method === 'GET')
              return json(
                await campaignRepairRecord(pool, actor, workspaceId, projectId, campaignId),
              );
            if (parts[6] === 'resources' && method === 'GET')
              return json(
                await campaignResourceRecord(pool, actor, workspaceId, projectId, campaignId),
              );
            // Review burden is only measurable if something records when a
            // person started looking.
            if (parts[6] === 'reviews' && method === 'POST') {
              const body = (await readJson(request)) as { assignmentId?: string };
              return json(
                await noteReviewOpened(
                  pool,
                  actor,
                  workspaceId,
                  projectId,
                  campaignId,
                  uuid.parse(body?.assignmentId ?? ''),
                ),
                201,
              );
            }
            if (parts[6] === 'activity' && method === 'GET')
              return json(await campaignActivity(pool, actor, workspaceId, projectId, campaignId));
            if (parts[6] === 'attention' && method === 'GET')
              return json(
                await campaignAttentionRecord(pool, actor, workspaceId, projectId, campaignId),
              );
            if (parts[6] === 'export' && method === 'GET') {
              const archive = await campaignExport(pool, actor, workspaceId, projectId, campaignId);
              // The export is a file to keep, never rendered on this origin.
              return new Response(new Uint8Array(archive.bytes), {
                headers: {
                  ...privateHeaders,
                  'Content-Type': 'application/zip',
                  'Content-Disposition': `attachment; filename="${archive.filename}"`,
                  'X-Content-Type-Options': 'nosniff',
                  'X-Trialoom-Redaction': redactionPolicy,
                  'X-Trialoom-Export-Hash': archive.manifest.contentHash,
                },
              });
            }
            if (parts[6] === 'publication' && method === 'POST')
              return json(
                await publishCampaign(
                  pool,
                  actor,
                  workspaceId,
                  projectId,
                  campaignId,
                  await readJson(request),
                ),
                201,
              );
            if (parts[6] === 'budget' && method === 'POST')
              return json(
                await authorizeMore(
                  pool,
                  actor,
                  workspaceId,
                  projectId,
                  campaignId,
                  await readJson(request),
                ),
                201,
              );
            if (parts[6] === 'status' && method === 'POST')
              return json(
                await setCampaignStatus(
                  pool,
                  actor,
                  workspaceId,
                  projectId,
                  campaignId,
                  await readJson(request),
                ),
              );
          }
          if (
            parts.length === 7 &&
            parts[4] === 'campaigns' &&
            parts[6] === 'terms' &&
            method === 'POST'
          )
            return json(
              await reviseTerms(
                pool,
                actor,
                workspaceId,
                projectId,
                uuid.parse(parts[5]),
                await readJson(request),
              ),
              201,
            );
        }
      }
      if (parts.length === 3 && parts[2] === 'access' && method === 'GET')
        return json(await workspaceAccess(pool, actor, workspaceId));
      if (parts.length === 3 && parts[2] === 'attention' && method === 'GET')
        return json(await workspaceAttention(pool, actor, workspaceId));
      if (parts.length === 3 && parts[2] === 'metrics' && method === 'GET')
        return json(await pilotReadiness(pool, actor, workspaceId));
      if (parts.length === 3 && parts[2] === 'runner-hosts') {
        if (method === 'GET') return json(await workspaceHosts(pool, actor, workspaceId));
        if (method === 'POST')
          return json(await registerHost(pool, actor, workspaceId, await readJson(request)), 201);
      }
      if (parts.length === 4 && parts[2] === 'runner-hosts' && method === 'DELETE')
        return json(await revokeHost(pool, actor, workspaceId, parts[3]));
      if (parts.length === 3 && parts[2] === 'notices') {
        if (method === 'GET') return json(await workspaceNotices(pool, actor, workspaceId));
        if (method === 'POST')
          return json(
            await registerEndpoint(pool, actor, workspaceId, await readJson(request)),
            201,
          );
      }
      if (parts.length === 4 && parts[2] === 'notices' && method === 'DELETE')
        return json(await revokeEndpoint(pool, actor, workspaceId, parts[3]));
      if (parts.length === 3 && parts[2] === 'payment-authorities') {
        if (method === 'GET') return json(await workspaceAuthorities(pool, actor, workspaceId));
        if (method === 'POST')
          return json(
            await registerAuthority(pool, actor, workspaceId, await readJson(request)),
            201,
          );
      }
      if (parts.length === 4 && parts[2] === 'payment-authorities') {
        const authorityId = uuid.parse(parts[3]);
        if (method === 'POST')
          return json(
            await topUpAuthority(pool, actor, workspaceId, authorityId, await readJson(request)),
          );
        if (method === 'DELETE')
          return json(
            await revokeAuthority(pool, actor, workspaceId, authorityId, await readJson(request)),
          );
      }
      // Reading the approval from the chain is a provider call, so it is a
      // mutation: it records an observation and may mark the authority short.
      if (
        parts.length === 5 &&
        parts[2] === 'payment-authorities' &&
        parts[4] === 'verification' &&
        method === 'POST'
      )
        return json(
          await verifyAuthority(
            pool,
            actor,
            workspaceId,
            uuid.parse(parts[3]),
            configuredPayments(pool)?.reader ?? unreadableAuthority,
          ),
        );
      if (parts.length === 3 && parts[2] === 'invitations' && method === 'POST') {
        const invite = await createInvitation(pool, actor, workspaceId, await readJson(request));
        return json(
          { id: invite.id, expiresAt: invite.expiresAt, url: `/join#token=${invite.token}` },
          201,
        );
      }
      if (parts.length === 4 && parts[2] === 'invitations' && method === 'DELETE') {
        await revokeInvitation(pool, actor, workspaceId, uuid.parse(parts[3]));
        return json({ ok: true });
      }
      if (parts.length === 4 && parts[2] === 'members' && method === 'DELETE') {
        await removeMember(pool, actor, workspaceId, uuid.parse(parts[3]));
        return json({ ok: true });
      }
    }
    throw new AppError('NOT_FOUND', 'This action is not available.', 404);
  });
}
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
