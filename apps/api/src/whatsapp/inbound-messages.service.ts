import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { log } from '../common/logger.js';

/** How long one worker may hold a message (an AI turn takes up to ~45 s). An expired claim can be taken over. */
export const INBOUND_LEASE_MS = 2 * 60_000;
const CLAIMABLE = ['received', 'queued'];

export type InboundRow = Prisma.InboundMessageGetPayload<object>;

/**
 * Durable lifecycle of one inbound WhatsApp message: one row per (organization, Meta message id).
 *
 *   webhook  -> accept()          row created (unique) or recognised as a duplicate
 *            -> markQueued()      BullMQ job added (job id = the message id)
 *   worker   -> claim()           compare-and-set to "processing" with a lease: only one worker answers it
 *            -> saveReply()       the generated reply is stored BEFORE sending (a retry re-sends this text, the
 *                                 AI is not run again)
 *            -> markSending()     compare-and-set pending -> sending: only one send attempt is ever in flight
 *            -> markSent() / markSendRetryable() / markUnknown() / markFailed()
 *
 * A reply whose send started but never finished ("sending" after a crash, or a timeout after the request was sent)
 * becomes "unknown" and is never sent again automatically: the Cloud API has no idempotency key, so resending
 * could message the customer twice.
 */
@Injectable()
export class InboundMessageService {
  constructor(private readonly prisma: PrismaService) {}

  async accept(input: { organizationId: string; providerMessageId: string; fromPhone: string; messageType: string; payload?: Prisma.InputJsonValue }): Promise<{ outcome: 'new' | 'duplicate' | 'requeue'; row: InboundRow }> {
    try {
      const row = await this.prisma.inboundMessage.create({ data: { ...input, status: 'received' } });
      return { outcome: 'new', row };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const row = await this.prisma.inboundMessage.findUniqueOrThrow({ where: { organizationId_providerMessageId: { organizationId: input.organizationId, providerMessageId: input.providerMessageId } } });
      // Persisted earlier but the queue add failed (we answered 500): Meta's retry may queue it now.
      return { outcome: row.status === 'received' ? 'requeue' : 'duplicate', row };
    }
  }

  markQueued(id: string) {
    return this.prisma.inboundMessage.updateMany({ where: { id, status: 'received' }, data: { status: 'queued' } });
  }

  /**
   * Take the message for processing. Returns null when it is done, or another worker holds a live claim (a
   * re-delivered or stalled BullMQ job running in parallel gets nothing to do). Jobs from before this table
   * existed get their row created here.
   */
  async claim(input: { organizationId: string; providerMessageId: string; fromPhone: string; messageType: string }, now = new Date()): Promise<InboundRow | null> {
    const key = { organizationId_providerMessageId: { organizationId: input.organizationId, providerMessageId: input.providerMessageId } };
    let row = await this.prisma.inboundMessage.findUnique({ where: key });
    if (!row) row = (await this.accept(input)).row;
    const claimed = await this.prisma.inboundMessage.updateMany({
      where: {
        id: row.id,
        OR: [{ status: { in: CLAIMABLE } }, { status: 'processing', lockedUntil: { lt: now } }],
      },
      data: { status: 'processing', lockedUntil: new Date(now.getTime() + INBOUND_LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.inboundMessage.findUniqueOrThrow({ where: { id: row.id } });
  }

  saveReply(id: string, replyText: string, conversationId?: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { replyText, replyStatus: 'pending', conversationId } });
  }

  async markSending(id: string) {
    const r = await this.prisma.inboundMessage.updateMany({ where: { id, replyStatus: 'pending' }, data: { replyStatus: 'sending' } });
    return r.count === 1;
  }

  markSent(id: string, replyProviderId?: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'replied', replyStatus: 'accepted', replyProviderId, lockedUntil: null, processedAt: new Date(), lastError: null } });
  }

  /** The request never reached Meta (or Meta said "try later"): the same reply may be sent on the next attempt. */
  markSendRetryable(id: string, error: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'queued', replyStatus: 'pending', lockedUntil: null, lastError: error.slice(0, 500) } });
  }

  /** Processing failed before anything was sent: give the message back for the next attempt. */
  release(id: string, error: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'queued', lockedUntil: null, lastError: error.slice(0, 500) } });
  }

  markUnknown(id: string, error: string) {
    log.warn('whatsapp.reply_delivery_unknown', { inboundId: id, error: error.slice(0, 200) });
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'reply_unknown', replyStatus: 'unknown', lockedUntil: null, processedAt: new Date(), lastError: error.slice(0, 500) } });
  }

  markFailed(id: string, error: string, opts: { replyFailed?: boolean } = {}) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'failed', ...(opts.replyFailed ? { replyStatus: 'failed' } : {}), ...(error ? { lastError: error.slice(0, 500) } : {}), lockedUntil: null, processedAt: new Date() } });
  }

  markSkipped(id: string, reason: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'skipped', lockedUntil: null, processedAt: new Date(), lastError: reason.slice(0, 500) } });
  }

  /** The sweep queued it again: noted (and its clock reset) so it is not re-queued every minute. */
  noteRequeued(id: string) {
    return this.prisma.inboundMessage.update({ where: { id }, data: { status: 'queued', lastError: 're-queued by the sweep' } });
  }

  /** Dashboard: latest inbound messages with their processing / reply state, and counts per state (last 24 h). */
  async recent(organizationId: string, opts: { status?: string; limit?: number } = {}) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [rows, counts] = await Promise.all([
      this.prisma.inboundMessage.findMany({
        where: { organizationId, ...(opts.status ? { status: opts.status } : {}) },
        orderBy: { receivedAt: 'desc' },
        take: Math.min(200, Math.max(1, opts.limit ?? 50)),
        select: { id: true, providerMessageId: true, fromPhone: true, messageType: true, status: true, attempts: true, replyStatus: true, replyProviderId: true, lastError: true, receivedAt: true, processedAt: true, conversationId: true },
      }),
      this.prisma.inboundMessage.groupBy({ by: ['status'], where: { organizationId, receivedAt: { gte: since } }, _count: { _all: true } }),
    ]);
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      // Masked: the dashboard row links to the conversation for the full details.
      messages: rows.map((r) => ({ ...r, fromPhone: r.fromPhone.length > 4 ? `${'*'.repeat(r.fromPhone.length - 4)}${r.fromPhone.slice(-4)}` : r.fromPhone })),
    };
  }

  /** Persisted but never queued, or queued long ago and never finished (lost job): candidates to re-queue. */
  stuck(olderThanMs = 5 * 60_000, now = new Date()) {
    const before = new Date(now.getTime() - olderThanMs);
    return this.prisma.inboundMessage.findMany({ where: { status: { in: CLAIMABLE }, updatedAt: { lt: before } }, take: 100, orderBy: { receivedAt: 'asc' } });
  }
}
