import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { FollowUpsModule } from '../follow-ups/follow-ups.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { TextileController } from './textile.controller.js';
import { TextileService } from './textile.service.js';
import { TextileEvents } from './textile-events.js';

@Module({
  imports: [ConversationsModule, FollowUpsModule, LeadsModule],
  controllers: [TextileController],
  providers: [TextileService, TextileEvents],
  exports: [TextileService, TextileEvents],
})
export class TextileModule {}
