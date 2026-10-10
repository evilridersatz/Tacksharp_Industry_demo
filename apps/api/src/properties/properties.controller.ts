import { Org } from '../auth/decorators.js';
import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PropertiesService } from './properties.service.js';
import { parseBhk, parseIndianBudget } from '../common/parsers.js';

@Controller('properties')
export class PropertiesController {
  constructor(private readonly propertiesService: PropertiesService) {}

  @Get('search')
  search(
    @Org() organizationId: string,
    @Query('location') location?: string,
    @Query('bhk') bhk?: string,
    @Query('propertyType') propertyType?: string,
    @Query('maxBudget') maxBudget?: string,
  ) {
    return this.propertiesService.searchProperties({
      organizationId,
      location,
      bhk: parseBhk(bhk),
      propertyType,
      maxBudget: parseIndianBudget(maxBudget),
    });
  }

  @Get(':propertyId')
  async details(@Org() organizationId: string, @Param('propertyId') propertyId: string) {
    const property = await this.propertiesService.getPropertyDetails({
      organizationId,
      propertyId,
    });
    if (!property) throw new NotFoundException('Property not found');
    return property;
  }
}
