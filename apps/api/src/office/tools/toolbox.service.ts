import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApprovalsService } from '../../governance/approvals.service.js';
import { WorkTasksService } from '../../governance/work-tasks.service.js';
import { JarvisService } from '../../jarvis/jarvis.service.js';
import { JarvisDataService } from '../../jarvis/jarvis-data.service.js';
import { InboxService } from '../../inbox/inbox.service.js';
import { ConversationsService } from '../../conversations/conversations.service.js';
import { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service.js';
import { KnowledgeService } from '../../knowledge/knowledge.service.js';
import { buildBusinessTools } from './business-tools.js';
import { OfficeToolRegistry } from './registry.js';

/** The office tool registry, bound to the platform's existing services (nothing is duplicated). */
@Injectable()
export class OfficeToolbox {
  readonly registry: OfficeToolRegistry;

  constructor(
    prisma: PrismaService,
    approvals: ApprovalsService,
    workTasks: WorkTasksService,
    jarvis: JarvisService,
    jarvisData: JarvisDataService,
    inbox: InboxService,
    conversations: ConversationsService,
    sender: WhatsAppSenderService,
    @Optional() knowledge?: KnowledgeService,
  ) {
    this.registry = new OfficeToolRegistry(prisma, approvals, buildBusinessTools({ prisma, jarvis, jarvisData, workTasks, inbox, conversations, sender, knowledge }));
  }
}
