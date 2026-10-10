import { Org } from '../auth/decorators.js';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ConversationsService } from './conversations.service.js';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(@Org() organizationId: string, @Query('channel') channel?: string) {
    return this.conversationsService.listConversations(organizationId, channel);
  }

  @Get(':conversationId/messages')
  getMessages(@Org() organizationId: string, @Param('conversationId') conversationId: string) {
    return this.conversationsService.getMessages(organizationId, conversationId);
  }
}
