import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { KNOWLEDGE_DIR, KnowledgeService, safeName } from './knowledge.service.js';
import { sha256 } from './text.js';

type Actor = { sub: string; org: string };
const MAX_ANSWER = 20_000;

/** Lower-case, punctuation removed (any script, so Tamil stays), spaces collapsed: "Sunday timings?" == "sunday  timings". */
export function questionKey(q: string): string {
  return q.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

/** Did the agent fall back because its knowledge had no answer? (Not escalations, not after-hours replies.) */
export function isKnowledgeGap(fallbackMessage: string, r: { reply: string; source: string; escalate: boolean }): boolean {
  if (r.escalate || r.source === 'escalation' || r.source === 'knowledge') return false;
  const fb = questionKey(fallbackMessage);
  return fb.length > 0 && questionKey(r.reply).includes(fb);
}

/**
 * Records (or counts again) a question the agent could not answer. Never throws: gap tracking must not break a call.
 * Greetings and one-word messages are not gaps.
 */
export async function recordKnowledgeGap(prisma: PrismaService, g: { organizationId: string; knowledgeBaseId: string | null; agentId: string; question: string; channel: 'call' | 'console' }) {
  if (!g.knowledgeBaseId) return;
  const key = questionKey(g.question);
  if (key.length < 6 || key.split(' ').length < 2) return;
  try {
    const existing = await prisma.knowledgeGap.findUnique({ where: { knowledgeBaseId_questionKey: { knowledgeBaseId: g.knowledgeBaseId, questionKey: key } } });
    if (existing) {
      // Asked again after it was "answered": the answer did not help, so it is open again. Ignored stays ignored.
      await prisma.knowledgeGap.update({ where: { id: existing.id }, data: { count: { increment: 1 }, lastAskedAt: new Date(), channel: g.channel, ...(existing.status === 'answered' ? { status: 'open', resolvedAt: null } : {}) } });
    } else {
      await prisma.knowledgeGap.create({ data: { organizationId: g.organizationId, knowledgeBaseId: g.knowledgeBaseId, agentId: g.agentId, questionKey: key, question: g.question.trim().slice(0, 1000), channel: g.channel } });
    }
  } catch {
    /* a concurrent first insert or a deleted base: nothing to record */
  }
}

/**
 * Knowledge studio: everything about a knowledge base in one place. Typed answers are ordinary text documents
 * (`authored`), indexed by the same pipeline as uploads, so the agents use them exactly like a file. Unanswered
 * questions (gaps) come from real calls and the test console; answering one writes such a document.
 */
@Injectable()
export class KnowledgeStudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kb: KnowledgeService,
  ) {}

  async overview(org: string) {
    const bases = await this.prisma.knowledgeBase.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true, agents: { select: { id: true, name: true, status: true } }, _count: { select: { documents: true } } },
    });
    const gaps = await this.prisma.knowledgeGap.groupBy({ by: ['knowledgeBaseId'], where: { organizationId: org, status: 'open' }, _count: { _all: true } });
    const open = new Map(gaps.map((g) => [g.knowledgeBaseId, g._count._all]));
    return bases.map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, agents: b.agents, documents: b._count.documents, openGaps: open.get(b.id) ?? 0 }));
  }

  async passages(org: string, documentId: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id: documentId, organizationId: org }, select: { id: true, filename: true, status: true, authored: true, flaggedLines: true } });
    if (!d) throw new NotFoundException('Document not found');
    const chunks = await this.prisma.knowledgeChunk.findMany({ where: { documentId: d.id, organizationId: org }, orderBy: { ord: 'asc' }, select: { ord: true, source: true, text: true }, take: 500 });
    return { document: d, passages: chunks };
  }

  /** The editable text of a typed answer. */
  async answer(org: string, documentId: string) {
    const d = await this.authoredDoc(org, documentId);
    const raw = await fs.readFile(d.storagePath, 'utf8');
    const [title, ...rest] = raw.split('\n');
    return { id: d.id, title: title.trim(), text: rest.join('\n').trim(), status: d.status, knowledgeBaseId: d.knowledgeBaseId };
  }

  async writeAnswer(actor: Actor, knowledgeBaseId: string, body: { title?: unknown; text?: unknown; gapId?: unknown }) {
    const { title, text } = this.validate(body);
    let gap = null;
    if (body.gapId) {
      gap = await this.prisma.knowledgeGap.findFirst({ where: { id: String(body.gapId), organizationId: actor.org, knowledgeBaseId } });
      if (!gap) throw new NotFoundException('Question not found.');
    }
    const doc = await this.kb.upload(actor.org, knowledgeBaseId, { originalname: `${fileTitle(title)}.txt`, buffer: Buffer.from(`${title}\n\n${text}\n`, 'utf8') }, `user:${actor.sub}`);
    await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { authored: true } });
    if (gap) await this.prisma.knowledgeGap.update({ where: { id: gap.id }, data: { status: 'answered', documentId: doc.id, resolvedBy: actor.sub, resolvedAt: new Date() } });
    return { ...(await this.kb.document(actor.org, doc.id)), authored: true };
  }

  async editAnswer(actor: Actor, documentId: string, body: { title?: unknown; text?: unknown }) {
    const d = await this.authoredDoc(actor.org, documentId);
    if (d.status === 'processing') throw new ConflictException('This answer is being indexed right now; try again in a moment.');
    const { title, text } = this.validate(body);
    const buffer = Buffer.from(`${title}\n\n${text}\n`, 'utf8');
    const digest = sha256(buffer);
    const dupe = await this.prisma.knowledgeDocument.findFirst({ where: { organizationId: actor.org, knowledgeBaseId: d.knowledgeBaseId, sha256: digest, id: { not: d.id } } });
    if (dupe) throw new ConflictException(`The same text is already in this knowledge base (${dupe.filename}).`);
    // storagePath was generated by the server under this organization's folder; check before writing anyway.
    if (!path.resolve(d.storagePath).startsWith(path.join(KNOWLEDGE_DIR, actor.org) + path.sep)) throw new ConflictException('This answer cannot be edited.');
    await fs.writeFile(d.storagePath, buffer, { mode: 0o600 });
    await this.prisma.knowledgeDocument.update({ where: { id: d.id }, data: { filename: `${fileTitle(title)}.txt`, sha256: digest, sizeBytes: buffer.length } });
    await this.prisma.auditEvent.create({ data: { organizationId: actor.org, actor: `user:${actor.sub}`, entityType: 'knowledge_document', entityId: d.id, action: 'knowledge.answer_edited', data: { title } } });
    return this.kb.reprocess(actor.org, d.id, `user:${actor.sub}`);
  }

  gaps(org: string, q: { knowledgeBaseId?: string; status?: string }) {
    const status = ['open', 'answered', 'ignored'].includes(String(q.status)) ? String(q.status) : 'open';
    return this.prisma.knowledgeGap.findMany({
      where: { organizationId: org, status, ...(q.knowledgeBaseId ? { knowledgeBaseId: q.knowledgeBaseId } : {}) },
      orderBy: [{ count: 'desc' }, { lastAskedAt: 'desc' }],
      take: 200,
      select: { id: true, knowledgeBaseId: true, agentId: true, question: true, channel: true, count: true, status: true, documentId: true, firstAskedAt: true, lastAskedAt: true, resolvedAt: true },
    });
  }

  async setGapStatus(actor: Actor, id: string, status: unknown) {
    if (status !== 'ignored' && status !== 'open') throw new BadRequestException('Status: ignored or open.');
    const g = await this.prisma.knowledgeGap.findFirst({ where: { id, organizationId: actor.org } });
    if (!g) throw new NotFoundException('Question not found.');
    return this.prisma.knowledgeGap.update({ where: { id }, data: { status, resolvedBy: status === 'ignored' ? actor.sub : null, resolvedAt: status === 'ignored' ? new Date() : null } });
  }

  private async authoredDoc(org: string, id: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id, organizationId: org } });
    if (!d) throw new NotFoundException('Document not found');
    if (!d.authored) throw new BadRequestException('Only answers written in the studio can be edited here. Upload a new version of the file instead.');
    return d;
  }

  private validate(body: { title?: unknown; text?: unknown }) {
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
    const errors: Record<string, string> = {};
    if (title.length < 3 || title.length > 160) errors.title = 'A question or title (3-160 characters).';
    if (text.length < 10 || text.length > MAX_ANSWER) errors.text = `The answer (10-${MAX_ANSWER.toLocaleString()} characters).`;
    if (Object.keys(errors).length) throw new BadRequestException({ statusCode: 400, message: 'Please complete the answer.', errors });
    return { title, text };
  }
}

const fileTitle = (t: string) => safeName(t.replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80)) || 'Answer';
