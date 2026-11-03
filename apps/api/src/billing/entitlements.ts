import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PLANS, RESOURCE_LABEL, effectiveLimits, type Resource } from './plans.js';

/** Thrown when a plan limit stops a creation; the dashboard shows the message as is. */
export class PlanLimitError extends ForbiddenException {
  constructor(message: string, readonly resource: Resource) {
    super({ statusCode: 403, code: 'plan_limit', message, resource });
  }
}

/** Current use of every limited resource. Open invitations and guest memberships count as seats. */
export async function planUsage(prisma: PrismaService, org: string): Promise<Record<Resource, number>> {
  const [users, guests, invites, voiceAgents, workflows, dripSequences, mcpKeys] = await Promise.all([
    prisma.user.count({ where: { organizationId: org, disabledAt: null } }),
    prisma.organizationMembership.count({ where: { organizationId: org, user: { disabledAt: null, NOT: { organizationId: org } } } }),
    prisma.userInvitation.count({ where: { organizationId: org, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.voiceAgent.count({ where: { organizationId: org, status: { not: 'archived' } } }),
    prisma.workflow.count({ where: { organizationId: org } }),
    prisma.dripSequence.count({ where: { organizationId: org } }),
    prisma.mcpAccessKey.count({ where: { organizationId: org, revokedAt: null } }),
  ]);
  return { users: users + guests + invites, voiceAgents, workflows, dripSequences, mcpKeys };
}

/**
 * Throws PlanLimitError when adding one more `resource` would exceed the organization's plan.
 * An organization with NO subscription row has no limits (every tenant that existed before plans, e.g. GR Chicken).
 */
export async function assertPlanAllows(prisma: PrismaService, org: string, resource: Resource) {
  const sub = await prisma.subscription.findUnique({ where: { organizationId: org }, select: { planCode: true, status: true, limitsOverride: true } });
  if (!sub) return;
  if (sub.status === 'cancelled') throw new PlanLimitError("This workspace's subscription is cancelled: nothing new can be added. Contact Tacksharp to renew.", resource);
  const limit = effectiveLimits(sub.planCode, sub.limitsOverride)[resource];
  if (limit === null) return;
  const used = (await planUsage(prisma, org))[resource];
  if (used < limit) return;
  const plan = PLANS[sub.planCode as keyof typeof PLANS]?.name ?? sub.planCode;
  throw new PlanLimitError(
    limit === 0
      ? `Your ${plan} plan does not include ${RESOURCE_LABEL[resource]}. Contact Tacksharp to upgrade.`
      : `Your ${plan} plan allows ${limit} ${RESOURCE_LABEL[resource]} and ${used} are in use. Remove one or contact Tacksharp to upgrade.`,
    resource,
  );
}
