import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage, log } from '../common/logger.js';
import { KB_MAX_CHARS_PER_DOC, KB_MAX_DOCS_PER_BASE, KbFileError, bm25, chunkSections, detectKind, extractSections, neutralise, sha256, type KbKind } from './text.js';

export const KNOWLEDGE_DIR = path.resolve(process.env.KNOWLEDGE_DIR || './data/knowledge');
const MAX_CHUNKS_PER_BASE = 6000;

export type Passage = { text: string; source: string; filename: string; documentId: string; score: number };

/**
 * Tenant knowledge bases. Every query is scoped by organizationId from the session; files live under
 * KNOWLEDGE_DIR/<organizationId>/<knowledgeBaseId>/ with server-generated names (the uploaded name is never a path).
 * A document is only "indexed" after its text was extracted, neutralised, chunked and stored; until then the
 * dashboard shows "processing" (never a success that did not happen).
 */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  /** Chunks per knowledge base, invalidated on any change (small: lexical retrieval over a few thousand chunks). */
  private readonly cache = new Map<string, { at: number; chunks: Array<{ text: string; source: string; filename: string; documentId: string }> }>();
  /** Tests can process synchronously. */
  processInline = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // A restart during processing leaves a document "processing" forever: mark it failed so it can be retried.
    await this.prisma.knowledgeDocument
      .updateMany({ where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: 'failed', error: 'Processing was interrupted. Press Retry.' } })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------- bases

  listBases(organizationId: string) {
    return this.prisma.knowledgeBase.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { documents: { orderBy: { createdAt: 'desc' }, select: DOC_FIELDS }, agents: { select: { id: true, name: true, status: true } } },
    });
  }

  async getBase(organizationId: string, id: string) {
    const kb = await this.prisma.knowledgeBase.findFirst({
      where: { id, organizationId },
      include: { documents: { orderBy: { createdAt: 'desc' }, select: DOC_FIELDS }, agents: { select: { id: true, name: true, status: true } } },
    });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    return kb;
  }

  async createBase(organizationId: string, name: unknown) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (n.length < 2 || n.length > 80) throw new BadRequestException('Give the knowledge base a name (2 to 80 characters).');
    return this.prisma.knowledgeBase.create({ data: { organizationId, name: n } });
  }

  async deleteBase(organizationId: string, id: string) {
    const kb = await this.getBase(organizationId, id);
    if (kb.agents.some((a) => a.status === 'active')) throw new ConflictException('An active agent uses this knowledge base. Detach it or archive the agent first.');
    await this.prisma.knowledgeBase.delete({ where: { id: kb.id } });
    await fs.rm(path.join(KNOWLEDGE_DIR, organizationId, kb.id), { recursive: true, force: true });
    this.invalidate(organizationId, kb.id);
    return { deleted: true };
  }

  // ------------------------------------------------------------------------------------------- documents

  async upload(organizationId: string, knowledgeBaseId: string, file: { originalname?: string; buffer?: Buffer } | undefined, actor: string) {
    if (!file?.buffer || !file.originalname) throw new BadRequestException('Choose a file to upload.');
    const kb = await this.prisma.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, organizationId }, include: { _count: { select: { documents: true } } } });
    if (!kb) throw new NotFoundException('Knowledge base not found');
    if (kb._count.documents >= KB_MAX_DOCS_PER_BASE) throw new BadRequestException(`A knowledge base holds at most ${KB_MAX_DOCS_PER_BASE} documents.`);
    const filename = safeName(file.originalname);
    let kind: KbKind;
    try {
      kind = detectKind(filename, file.buffer);
    } catch (e) {
      throw new BadRequestException(e instanceof KbFileError ? e.message : 'This file cannot be used.');
    }
    const digest = sha256(file.buffer);
    const dupe = await this.prisma.knowledgeDocument.findFirst({ where: { organizationId, knowledgeBaseId, sha256: digest } });
    if (dupe) throw new ConflictException(`This file is already in the knowledge base (${dupe.filename}).`);
    const doc = await this.prisma.knowledgeDocument.create({
      data: { organizationId, knowledgeBaseId, filename, kind, sizeBytes: file.buffer.length, sha256: digest, status: 'uploaded', storagePath: '', createdBy: actor },
    });
    const dir = path.join(KNOWLEDGE_DIR, organizationId, knowledgeBaseId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const storagePath = path.join(dir, `${doc.id}.${kind}`);
    await fs.writeFile(storagePath, file.buffer, { mode: 0o600 });
    await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { storagePath } });
    await this.audit(organizationId, actor, doc.id, 'knowledge.uploaded', { kind, sizeBytes: file.buffer.length });
    await this.schedule(doc.id);
    return this.document(organizationId, doc.id);
  }

  async document(organizationId: string, id: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id, organizationId }, select: DOC_FIELDS });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  async reprocess(organizationId: string, id: string, actor: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id, organizationId } });
    if (!d) throw new NotFoundException('Document not found');
    if (d.status === 'processing') throw new ConflictException('This document is being processed right now.');
    await this.prisma.knowledgeDocument.update({ where: { id }, data: { status: 'uploaded', error: null } });
    await this.audit(organizationId, actor, id, 'knowledge.reprocess', {});
    await this.schedule(id);
    return this.document(organizationId, id);
  }

  async deleteDocument(organizationId: string, id: string, actor: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id, organizationId } });
    if (!d) throw new NotFoundException('Document not found');
    await this.prisma.knowledgeDocument.delete({ where: { id } }); // chunks cascade
    if (d.storagePath && path.resolve(d.storagePath).startsWith(path.join(KNOWLEDGE_DIR, organizationId) + path.sep)) {
      await fs.rm(d.storagePath, { force: true });
    }
    this.invalidate(organizationId, d.knowledgeBaseId);
    await this.audit(organizationId, actor, id, 'knowledge.deleted', { filename: d.filename });
    return { deleted: true };
  }

  private async schedule(documentId: string) {
    if (this.processInline) return this.process(documentId);
    setImmediate(() => void this.process(documentId));
  }

  /** uploaded -> processing -> indexed | failed. Never throws. */
  async process(documentId: string) {
    const claimed = await this.prisma.knowledgeDocument.updateMany({ where: { id: documentId, status: { in: ['uploaded', 'failed'] } }, data: { status: 'processing', error: null, attempts: { increment: 1 } } });
    if (!claimed.count) return;
    const doc = await this.prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc) return;
    try {
      const bytes = await fs.readFile(doc.storagePath);
      const sections = await extractSections(doc.kind as KbKind, bytes);
      let flagged = 0;
      let chars = 0;
      const clean = sections.map((s) => {
        const n = neutralise(s.text);
        flagged += n.flagged;
        chars += n.text.length;
        return { text: n.text, source: s.source };
      });
      if (chars < 20) throw new Error(doc.kind === 'pdf' ? 'No text found. Scanned PDFs (images of pages) are not supported; upload a text PDF, DOCX or TXT.' : 'The file has no usable text.');
      if (chars > KB_MAX_CHARS_PER_DOC) throw new Error(`The document is too long (${chars.toLocaleString()} characters; the limit is ${KB_MAX_CHARS_PER_DOC.toLocaleString()}). Split it into smaller files.`);
      const chunks = chunkSections(clean);
      const existing = await this.prisma.knowledgeChunk.count({ where: { knowledgeBaseId: doc.knowledgeBaseId, documentId: { not: doc.id } } });
      if (existing + chunks.length > MAX_CHUNKS_PER_BASE) throw new Error('This knowledge base is full. Remove older documents first.');
      await this.prisma.$transaction([
        this.prisma.knowledgeChunk.deleteMany({ where: { documentId: doc.id } }),
        this.prisma.knowledgeChunk.createMany({ data: chunks.map((c, i) => ({ organizationId: doc.organizationId, knowledgeBaseId: doc.knowledgeBaseId, documentId: doc.id, ord: i, text: c.text, source: c.source.slice(0, 190) })) }),
        this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'indexed', chunkCount: chunks.length, charCount: chars, flaggedLines: flagged, processedAt: new Date(), error: null } }),
      ]);
      this.invalidate(doc.organizationId, doc.knowledgeBaseId);
      log.info('knowledge.indexed', { documentId: doc.id, chunks: chunks.length, flagged });
    } catch (e) {
      const message = errorMessage(e).slice(0, 500);
      await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'failed', error: safeError(message) } }).catch(() => undefined);
      log.warn('knowledge.failed', { documentId: doc.id, error: message });
    }
  }

  // ------------------------------------------------------------------------------------------- retrieval

  /** Top passages for a question, from THIS organization's knowledge base only. */
  async search(organizationId: string, knowledgeBaseId: string | null | undefined, query: string, k = 4): Promise<Passage[]> {
    if (!knowledgeBaseId || !query.trim()) return [];
    const key = `${organizationId}:${knowledgeBaseId}`;
    let entry = this.cache.get(key);
    if (!entry || Date.now() - entry.at > 5 * 60_000) {
      const rows = await this.prisma.knowledgeChunk.findMany({
        where: { organizationId, knowledgeBaseId, document: { status: 'indexed' } },
        select: { text: true, source: true, documentId: true, document: { select: { filename: true } } },
        take: MAX_CHUNKS_PER_BASE,
      });
      entry = { at: Date.now(), chunks: rows.map((r) => ({ text: r.text, source: r.source ?? '', documentId: r.documentId, filename: r.document.filename })) };
      // Keyed by organization AND base: a forged base id from another tenant loads (and caches) nothing.
      this.cache.set(key, entry);
    }
    return bm25(query, entry.chunks, k);
  }

  private invalidate(organizationId: string, knowledgeBaseId: string) {
    this.cache.delete(`${organizationId}:${knowledgeBaseId}`);
  }

  /** Is every document of this base indexed (and is there at least one)? Publishing an agent requires it. */
  async readiness(organizationId: string, knowledgeBaseId: string) {
    const docs = await this.prisma.knowledgeDocument.groupBy({ by: ['status'], where: { organizationId, knowledgeBaseId }, _count: { _all: true } });
    const by = Object.fromEntries(docs.map((d) => [d.status, d._count._all])) as Record<string, number>;
    return { indexed: by.indexed ?? 0, pending: (by.uploaded ?? 0) + (by.processing ?? 0), failed: by.failed ?? 0 };
  }

  private audit(organizationId: string, actor: string, entityId: string, action: string, data: Record<string, unknown>) {
    return this.prisma.auditEvent.create({ data: { organizationId, actor, entityType: 'knowledge_document', entityId, action, data: data as object } });
  }
}

const DOC_FIELDS = { id: true, knowledgeBaseId: true, filename: true, kind: true, sizeBytes: true, status: true, error: true, chunkCount: true, charCount: true, flaggedLines: true, attempts: true, processedAt: true, createdAt: true } as const;

/** Display name only (never used as a path): no directories, control characters or odd bytes. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(-120) || 'document';
}

/** User-safe error text: no file-system paths. */
function safeError(message: string): string {
  return message.replace(/\/[\w./-]+/g, '[path]');
}
