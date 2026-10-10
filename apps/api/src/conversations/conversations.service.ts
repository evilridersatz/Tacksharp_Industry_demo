import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/phone.js';
import {
  normalizeLocation,
  normalizePropertyType,
  parseBhk,
  parseIndianBudget,
} from '../common/parsers.js';

interface CreateMessageInput {
  organizationId: string;
  conversationId: string;
  role: string;
  content: string;
  externalId?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface CustomerMemoryUpdate {
  name?: string;
  language?: string;
  location?: string;
  budget?: number | string;
  bhk?: number | string;
  propertyType?: string;
  purchaseTimeline?: string;
  objection?: string;
  interestedPropertyId?: string;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One conversation per (organization, channel, customer phone).
   * Always linked to the customer so follow-up logic can see replies.
   */
  async getOrCreateConversation(input: {
    organizationId: string;
    channel: string;
    externalId: string;
    customerId?: string;
  }) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        organizationId: input.organizationId,
        channel: input.channel,
        externalId: input.externalId,
      },
    });
    if (existing) {
      if (!existing.customerId && input.customerId) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: { customerId: input.customerId, updatedAt: new Date() },
        });
      }
      return existing;
    }
    try {
      return await this.prisma.conversation.create({
        data: {
          id: randomUUID(),
          organizationId: input.organizationId,
          customerId: input.customerId,
          channel: input.channel,
          externalId: input.externalId,
          status: 'active',
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      // Two concurrent first messages: the unique key won the race, read it back.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.conversation.findFirst({
          where: { organizationId: input.organizationId, channel: input.channel, externalId: input.externalId },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Last N messages, oldest first. Only N rows are read from the DB. */
  async getRecentMessages(conversationId: string, limit = 16) {
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse();
  }

  async getMessages(organizationId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return this.prisma.message.findMany({
      where: { organizationId, conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listConversations(organizationId: string, channel?: string) {
    const rows = await this.prisma.conversation.findMany({
      where: { organizationId, ...(channel ? { channel } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        Customer: { include: { leads: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        Message: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { Message: true } },
      },
    });
    return rows.map(({ Message, _count, Customer, ...c }) => ({
      ...c,
      customer: Customer ? { ...Customer, leads: undefined, lead: Customer.leads[0] ?? null } : null,
      lastMessage: Message[0] ?? null,
      messageCount: _count.Message,
    }));
  }

  async getCustomerByPhone(organizationId: string, phone: string) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    return this.prisma.customer.findFirst({ where: { organizationId, phone: normalized } });
  }

  async getOrCreateCustomerByPhone(organizationId: string, phone: string, extra?: { name?: string; source?: string }) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new BadRequestException(`Invalid phone number: ${phone}`);
    const existing = await this.prisma.customer.findFirst({ where: { organizationId, phone: normalized } });
    if (existing) {
      if (!existing.name && extra?.name) {
        return this.prisma.customer.update({ where: { id: existing.id }, data: { name: extra.name } });
      }
      return existing;
    }
    try {
      return await this.prisma.customer.create({
        data: { organizationId, phone: normalized, name: extra?.name, source: extra?.source },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.customer.findFirst({ where: { organizationId, phone: normalized } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Update structured memory. Values are normalized deterministically, never trusted raw. */
  async updateCustomerMemory(params: { organizationId: string; customerId: string; update: CustomerMemoryUpdate }) {
    const { update } = params;
    const customer = await this.prisma.customer.findFirst({
      where: { id: params.customerId, organizationId: params.organizationId },
    });
    if (!customer) return { updated: false, reason: 'Customer not found.' };

    const data: Prisma.CustomerUpdateInput = {};
    const saved: Record<string, unknown> = {};

    if (update.name?.trim()) data.name = saved.name = update.name.trim();
    if (update.language?.trim()) data.language = saved.language = update.language.trim().toLowerCase();
    if (update.location) {
      const location = normalizeLocation(update.location);
      if (location) data.location = saved.location = location;
    }
    if (update.budget !== undefined) {
      const budget = parseIndianBudget(update.budget);
      if (budget) {
        data.budget = budget;
        saved.budget = budget;
      } else {
        saved.budgetError = `Could not understand budget "${update.budget}". Ask the customer to confirm.`;
      }
    }
    if (update.bhk !== undefined) {
      const bhk = parseBhk(update.bhk);
      if (bhk) data.bhk = saved.bhk = bhk;
    }
    if (update.propertyType) {
      const type = normalizePropertyType(update.propertyType);
      if (type) data.propertyType = saved.propertyType = type;
    }
    if (update.purchaseTimeline?.trim()) data.purchaseTimeline = saved.purchaseTimeline = update.purchaseTimeline.trim();
    if (update.interestedPropertyId?.trim()) {
      data.interestedPropertyId = saved.interestedPropertyId = update.interestedPropertyId.trim();
    }
    if (update.objection?.trim()) {
      const line = update.objection.trim();
      const previous = customer.objections ?? '';
      if (!previous.includes(line)) {
        data.objections = `${previous}\n${line}`.trim().slice(-2000);
        saved.objection = line;
      }
    }

    if (Object.keys(data).length === 0) {
      return { updated: false, reason: 'Nothing new to save.', ...saved };
    }
    await this.prisma.customer.update({ where: { id: customer.id }, data });
    return { updated: true, saved };
  }

  async addMessage(input: CreateMessageInput) {
    if (!input.content?.trim()) {
      throw new BadRequestException('Message content is required');
    }
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          id: randomUUID(),
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          externalId: input.externalId,
          metadata: input.metadata,
        },
      }),
      this.prisma.conversation.update({
        where: { id: input.conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
    return message;
  }

  /** Has the customer messaged us on WhatsApp in the last 24h? (Meta customer-service window) */
  async isWhatsAppWindowOpen(organizationId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { lastInboundAt: true },
    });
    if (!customer?.lastInboundAt) return false;
    return Date.now() - customer.lastInboundAt.getTime() < 23.5 * 3600 * 1000;
  }
}
