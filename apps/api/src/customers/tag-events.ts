import type { PrismaService } from '../prisma/prisma.service.js';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean) : []);

/** Tags present after a change that were not there before (case-insensitive). */
export function addedTags(before: unknown, after: unknown): string[] {
  const had = new Set(list(before));
  return [...new Set(list(after))].filter((t) => !had.has(t));
}

/**
 * Records one `customer.tag_added` audit event per newly added tag: the Workflow Studio's "tag added" trigger reads
 * these (a customer's updatedAt changes for any edit, so it cannot tell when a tag arrived). Never throws.
 */
export async function recordTagsAdded(prisma: PrismaService, organizationId: string, customerId: string, before: unknown, after: unknown, actor: string) {
  const tags = addedTags(before, after).slice(0, 20);
  if (!tags.length) return;
  await prisma.auditEvent
    .createMany({ data: tags.map((tag) => ({ organizationId, actor, entityType: 'customer', entityId: customerId, action: 'customer.tag_added', data: { tag } })) })
    .catch(() => undefined);
}
