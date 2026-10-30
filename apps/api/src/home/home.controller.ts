import { Controller, Get, Query } from '@nestjs/common';
import { Org } from '../auth/decorators.js';
import { HomeService } from './home.service.js';

@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** Setup readiness, attention items, results and recent activity for the signed-in organization. */
  @Get()
  overview(@Org() organizationId: string, @Query('range') range?: string) {
    return this.home.overview(organizationId, range);
  }
}
