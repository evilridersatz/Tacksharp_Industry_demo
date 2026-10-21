import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { formatRupeesShort, normalizeLocation, normalizePropertyType } from '../common/parsers.js';

export type PropertySearchParams = {
  organizationId: string;
  location?: string;
  bhk?: number;
  propertyType?: string;
  maxBudget?: number;
};

type PropertyRow = {
  id: string;
  name: string;
  location: string;
  type: string;
  bhk: number;
  price: Prisma.Decimal;
  status: string;
};

/** Compact shape for the LLM: fewer tokens, price already readable. */
function compact(p: PropertyRow) {
  return {
    id: p.id,
    name: p.name,
    location: p.location,
    type: p.type,
    bhk: p.bhk,
    price: Number(p.price),
    priceText: formatRupeesShort(Number(p.price)),
  };
}

@Injectable()
export class PropertiesService {
  constructor(private readonly prisma: PrismaService) {}

  private where(params: PropertySearchParams, includeBudget: boolean): Prisma.PropertyWhereInput {
    const location = normalizeLocation(params.location);
    const type = normalizePropertyType(params.propertyType);
    return {
      organizationId: params.organizationId,
      status: 'available',
      // "contains" so "Porur" matches "Porur, Chennai" (MySQL default collation is case-insensitive)
      ...(location ? { location: { contains: location } } : {}),
      ...(params.bhk ? { bhk: params.bhk } : {}),
      ...(type ? { type } : {}),
      ...(includeBudget && params.maxBudget ? { price: { lte: params.maxBudget } } : {}),
    };
  }

  /** Raw search for the REST API / dashboard. */
  searchProperties(params: PropertySearchParams) {
    return this.prisma.property.findMany({
      where: this.where(params, true),
      orderBy: { price: 'asc' },
      take: 50,
    });
  }

  /**
   * Search for the AI agent. Returns at most 5 matches. If nothing fits the budget,
   * returns the closest options above budget, clearly labelled, so the agent can
   * offer real alternatives instead of inventing them.
   */
  async searchForAgent(params: PropertySearchParams) {
    const matches = await this.prisma.property.findMany({
      where: this.where(params, true),
      orderBy: { price: 'asc' },
      take: 5,
    });
    if (matches.length > 0 || !params.maxBudget) {
      return { count: matches.length, properties: matches.map(compact) };
    }
    const aboveBudget = await this.prisma.property.findMany({
      where: this.where(params, false),
      orderBy: { price: 'asc' },
      take: 3,
    });
    return {
      count: 0,
      properties: [],
      aboveBudgetAlternatives: aboveBudget.map(compact),
      note: 'No property within budget. aboveBudgetAlternatives cost more than the stated budget; mention that clearly if you offer them.',
    };
  }

  getPropertyDetails(params: { organizationId: string; propertyId: string }) {
    return this.prisma.property.findFirst({
      where: { id: params.propertyId, organizationId: params.organizationId },
    });
  }
}
