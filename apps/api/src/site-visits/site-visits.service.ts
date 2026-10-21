import { randomUUID } from 'crypto';
import { retryTransient } from '../common/retry.js';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { normalizePhone } from '../common/phone.js';
import { queueRedis } from '../queues/queues.js';
import { withLock } from '../common/redis-lock.js';
import { nextLeadStatus, type LeadStatus } from '../leads/leads.service.js';
import { checkVisitTime } from '../conversation/booking-rules.js';
import { log } from '../common/logger.js';

export const SITE_VISIT_STATUSES = {
  REQUESTED: 'requested',
  SCHEDULED: 'scheduled',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
} as const;

export type SiteVisitStatus =
  (typeof SITE_VISIT_STATUSES)[keyof typeof SITE_VISIT_STATUSES];

export type VisitValidationCode =
  | 'invalid'
  | 'past'
  | 'too_soon'
  | 'too_far'
  | 'outside_hours'
  | 'property_not_found'
  | 'property_unavailable'
  | 'property_not_presented'
  | 'lead_not_found'
  | 'lead_closed'
  | 'customer_not_found'
  | 'do_not_contact';

export type VisitValidation =
  | {
      ok: true;
      at: Date;
      property: { id: string; name: string; location: string };
      lead: { id: string; status: string; customerId: string };
    }
  | { ok: false; code: VisitValidationCode; message: string };

export type BookConfirmedResult =
  | { ok: true; duplicate: boolean; siteVisit: { id: string; propertyId: string; scheduledAt: Date; status: string }; replacedVisitId?: string }
  | { ok: false; code: VisitValidationCode | 'lock_timeout' | 'error'; message: string };

const ACTIVE_VISIT_STATUSES = ['requested', 'scheduled', 'confirmed'];

const ALLOWED_TRANSITIONS: Record<
  SiteVisitStatus,
  SiteVisitStatus[]
> = {
  requested: [
    'scheduled',
    'cancelled',
  ],

  scheduled: [
    'confirmed',
    'cancelled',
    'no_show',
  ],

  confirmed: [
    'completed',
    'cancelled',
    'no_show',
  ],

  completed: [],

  cancelled: [],

  no_show: [],
};

@Injectable()
export class SiteVisitsService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async createSiteVisit(params: {
    organizationId: string;
    leadId: string;
    customerId?: string;
    propertyId: string;
    scheduledAt: string;
    status?: SiteVisitStatus;
    notes?: string;
  }) {
    const {
      organizationId,
      leadId,
      customerId,
      propertyId,
      scheduledAt,
      status = SITE_VISIT_STATUSES.SCHEDULED,
      notes,
    } = params;

    const parsedScheduledAt =
      new Date(scheduledAt);

    if (
      Number.isNaN(
        parsedScheduledAt.getTime(),
      )
    ) {
      throw new BadRequestException(
        'Invalid scheduledAt date/time.',
      );
    }

    if (
      parsedScheduledAt.getTime() <=
      Date.now()
    ) {
      throw new BadRequestException(
        'Site visit must be scheduled for a future date and time.',
      );
    }

    const lead =
      await this.prisma.lead.findFirst({
        where: {
          id: leadId,
          organizationId,
        },

        include: {
          customer: true,
        },
      });

    if (!lead) {
      throw new NotFoundException(
        'Lead not found.',
      );
    }

    if (
      customerId &&
      lead.customerId !== customerId
    ) {
      throw new BadRequestException(
        'Customer does not belong to this lead.',
      );
    }

    const property =
      await this.prisma.property.findFirst({
        where: {
          id: propertyId,
          organizationId,
        },
      });

    if (!property) {
      throw new NotFoundException(
        'Property not found.',
      );
    }

    if (property.status !== 'available') {
      throw new BadRequestException(
        'This property is not currently available.',
      );
    }

    const existingSiteVisit =
      await this.prisma.siteVisit.findFirst({
        where: {
          organizationId,
          leadId,
          propertyId,

          scheduledAt:
            parsedScheduledAt,

          status: {
            in: [
              SITE_VISIT_STATUSES.REQUESTED,
              SITE_VISIT_STATUSES.SCHEDULED,
              SITE_VISIT_STATUSES.CONFIRMED,
            ],
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    if (existingSiteVisit) {
      return existingSiteVisit;
    }

    const siteVisit =
      await this.prisma.siteVisit.create({
        data: {
          id: randomUUID(),
          organizationId,
          leadId,

          customerId:
            customerId ??
            lead.customerId,

          propertyId,

          scheduledAt:
            parsedScheduledAt,

          status,

          notes,

          updatedAt: new Date(),
        },
      });

    await this.prisma.lead.update({
      where: {
        id: lead.id,
      },

      data: {
        status: 'site_visit',
      },
    });

    return siteVisit;
  }

  async bookByCustomerPhone(params: {
    organizationId: string;
    phone: string;
    propertyId: string;
    scheduledAt: string;
    notes?: string;
  }) {
    const {
      organizationId,
      phone,
      propertyId,
      scheduledAt,
      notes,
    } = params;

    const customer =
      await this.prisma.customer.findFirst({
        where: {
          organizationId,
          phone: normalizePhone(phone) ?? phone,
        },
      });

    if (!customer) {
      throw new NotFoundException(
        'Customer not found.',
      );
    }

    const lead =
      await this.prisma.lead.findFirst({
        where: {
          organizationId,
          customerId:
            customer.id,

          status: {
            not: 'lost',
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

    if (!lead) {
      throw new NotFoundException(
        'Active lead not found for this customer.',
      );
    }

    return this.createSiteVisit({
      organizationId,
      leadId: lead.id,
      customerId:
        customer.id,
      propertyId,
      scheduledAt,
      status:
        SITE_VISIT_STATUSES.SCHEDULED,
      notes,
    });
  }

  /** Used by the AI agent: book for a known customer's active lead. */
  async bookForCustomer(params: {
    organizationId: string;
    customerId: string;
    propertyId: string;
    scheduledAt: string;
    notes?: string;
  }) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        organizationId: params.organizationId,
        customerId: params.customerId,
        status: { notIn: ['lost', 'won', 'not_interested'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) {
      throw new NotFoundException('Active lead not found for this customer.');
    }
    return this.createSiteVisit({
      organizationId: params.organizationId,
      leadId: lead.id,
      customerId: params.customerId,
      propertyId: params.propertyId,
      scheduledAt: params.scheduledAt,
      status: SITE_VISIT_STATUSES.SCHEDULED,
      notes: params.notes,
    });
  }

  /**
   * Single gate every AI-initiated booking must pass. Pure facts only: the customer's consent is
   * checked by the conversation engine BEFORE this is called; this checks that what is being booked
   * is real, allowed and belongs to this customer.
   */
  async validateSiteVisitBooking(params: {
    organizationId: string;
    customerId: string;
    propertyId: string;
    scheduledAt: string | Date | undefined;
    leadId?: string;
    /** When given, the property must be one the customer was actually shown in this conversation. */
    presentedPropertyIds?: readonly string[];
    now?: Date;
  }): Promise<VisitValidation> {
    const time = checkVisitTime(params.scheduledAt, params.now ?? new Date());
    if (!time.ok) return time;

    if (params.presentedPropertyIds && !params.presentedPropertyIds.includes(params.propertyId)) {
      return { ok: false, code: 'property_not_presented', message: 'That property was not shown to the customer in this conversation.' };
    }

    const [customer, property] = await Promise.all([
      this.prisma.customer.findFirst({ where: { id: params.customerId, organizationId: params.organizationId } }),
      this.prisma.property.findFirst({ where: { id: params.propertyId, organizationId: params.organizationId } }),
    ]);
    if (!customer) return { ok: false, code: 'customer_not_found', message: 'Customer not found.' };
    if (customer.doNotContact) return { ok: false, code: 'do_not_contact', message: 'Customer is marked do-not-contact.' };
    if (!property) return { ok: false, code: 'property_not_found', message: 'Property not found.' };
    if (property.status !== 'available') return { ok: false, code: 'property_unavailable', message: 'This property is not currently available.' };

    const lead = await this.prisma.lead.findFirst({
      where: {
        organizationId: params.organizationId,
        customerId: customer.id,
        ...(params.leadId ? { id: params.leadId } : {}),
        status: { notIn: ['lost', 'won', 'not_interested'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) return { ok: false, code: params.leadId ? 'lead_closed' : 'lead_not_found', message: 'No active lead for this customer.' };

    return {
      ok: true,
      at: time.at,
      property: { id: property.id, name: property.name, location: property.location },
      lead: { id: lead.id, status: lead.status, customerId: lead.customerId },
    };
  }

  /**
   * Books a visit the customer has ALREADY explicitly confirmed (the engine guarantees that).
   *  - validated again here (time, property, lead, ownership)
   *  - serialised per lead+property with a Redis lock, then one DB transaction
   *  - idempotent: the same slot twice returns the existing visit; a different time for the same
   *    property replaces the earlier visit (cancelled) instead of creating a second one
   * Failures are returned, never thrown, and never leave a half-written booking behind.
   */
  async bookConfirmedVisit(params: {
    organizationId: string;
    customerId: string;
    propertyId: string;
    scheduledAt: string | Date;
    leadId?: string;
    presentedPropertyIds?: readonly string[];
    /** Short audit text stored with the visit: who confirmed what, when. */
    evidence: string;
    now?: Date;
  }): Promise<BookConfirmedResult> {
    const now = params.now ?? new Date();
    const validation = await this.validateSiteVisitBooking({ ...params, now });
    if (!validation.ok) return validation;

    const { at, lead, property } = validation;
    try {
      return await withLock(
        queueRedis,
        `sitevisit:${lead.id}:${property.id}`,
        async (): Promise<BookConfirmedResult> => {
          const active = await this.prisma.siteVisit.findMany({
            where: { organizationId: params.organizationId, leadId: lead.id, propertyId: property.id, status: { in: ACTIVE_VISIT_STATUSES }, scheduledAt: { gt: now } },
            orderBy: { createdAt: 'desc' },
          });
          const same = active.find((v) => v.scheduledAt.getTime() === at.getTime());
          if (same) {
            return { ok: true, duplicate: true, siteVisit: { id: same.id, propertyId: same.propertyId, scheduledAt: same.scheduledAt, status: same.status } };
          }
          const nextStatus = nextLeadStatus(lead.status, 'site_visit' as LeadStatus);
          const created = await retryTransient(() => this.prisma.$transaction(async (tx) => {
            for (const old of active) {
              await tx.siteVisit.update({ where: { id: old.id }, data: { status: 'cancelled', notes: 'Rescheduled by customer' } });
            }
            const visit = await tx.siteVisit.create({
              data: {
                id: randomUUID(),
                organizationId: params.organizationId,
                leadId: lead.id,
                customerId: params.customerId,
                propertyId: property.id,
                scheduledAt: at,
                status: SITE_VISIT_STATUSES.SCHEDULED,
                notes: params.evidence.slice(0, 190),
                updatedAt: new Date(),
              },
            });
            // Compare-and-swap: never overwrite a status that changed since validation (e.g. a human marked the lead won).
            if (nextStatus !== lead.status) await tx.lead.updateMany({ where: { id: lead.id, status: lead.status }, data: { status: nextStatus } });
            return visit;
          }), 'sitevisit.book');
          log.info('sitevisit.booked_by_ai', { siteVisitId: created.id, leadId: lead.id, propertyId: property.id, replaced: active.length });
          return {
            ok: true,
            duplicate: false,
            siteVisit: { id: created.id, propertyId: created.propertyId, scheduledAt: created.scheduledAt, status: created.status },
            replacedVisitId: active[0]?.id,
          };
        },
        { ttlMs: 15_000, waitMs: 5_000 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('sitevisit.book_failed', { leadId: lead.id, propertyId: property.id, error: message });
      return { ok: false, code: /Timed out waiting for lock/.test(message) ? 'lock_timeout' : 'error', message };
    }
  }

  async getSiteVisits(
    organizationId: string,
  ) {
    return this.prisma.siteVisit.findMany({
      where: {
        organizationId,
      },

      orderBy: {
        scheduledAt: 'asc',
      },
      include: { Customer: true, Property: true },
      take: 500,
    });
  }

  async getSiteVisit(
    organizationId: string,
    siteVisitId: string,
  ) {
    const siteVisit =
      await this.prisma.siteVisit.findFirst({
        where: {
          id: siteVisitId,
          organizationId,
        },
      });

    if (!siteVisit) {
      throw new NotFoundException(
        'Site visit not found.',
      );
    }

    return siteVisit;
  }

  async updateStatus(params: {
    organizationId: string;
    siteVisitId: string;
    status: SiteVisitStatus;
  }) {
    const {
      organizationId,
      siteVisitId,
      status,
    } = params;

    const siteVisit =
      await this.prisma.siteVisit.findFirst({
        where: {
          id: siteVisitId,
          organizationId,
        },
      });

    if (!siteVisit) {
      throw new NotFoundException(
        'Site visit not found.',
      );
    }

    const currentStatus =
      siteVisit.status as SiteVisitStatus;

    if (
      currentStatus === status
    ) {
      return siteVisit;
    }

    const allowed =
      ALLOWED_TRANSITIONS[
        currentStatus
      ] ?? [];

    if (
      !allowed.includes(status)
    ) {
      throw new BadRequestException(
        `Cannot change site visit status from "${currentStatus}" to "${status}".`,
      );
    }

    const updated =
      await this.prisma.siteVisit.update({
        where: {
          id: siteVisit.id,
        },

        data: {
          status,
        },
      });

    return updated;
  }
}
