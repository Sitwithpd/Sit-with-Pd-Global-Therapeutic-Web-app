import crypto from 'crypto';
import { ChatKnowledgeSourceType, Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import {
  KnowledgeDocumentChunk,
  KnowledgeIndexSourceResult,
  KnowledgeIndexStats,
} from '../../types/chat.types';
import { hashContent } from './contentHash.service';
import { embedText, embedTexts, embeddingToVectorLiteral } from './embedding.service';
import { extractAllBlogChunks, extractBlogChunks } from './extractors/blog.extractor';
import { extractAllCampChunks, extractCampChunks } from './extractors/camp.extractor';
import {
  extractAllCommunityChunks,
  extractCommunityChunks,
} from './extractors/community.extractor';
import {
  extractAllConsultationChunks,
  extractConsultationChunks,
} from './extractors/consultation.extractor';
import { extractPolicyChunks, POLICY_SOURCE_ID } from './extractors/policy.extractor';
import { extractAllProgramChunks, extractProgramChunks } from './extractors/program.extractor';
import {
  extractAllTestimonialChunks,
  extractTestimonialChunks,
} from './extractors/testimonial.extractor';

function emptyStats(): KnowledgeIndexStats {
  return {
    sourcesProcessed: 0,
    chunksIndexed: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    embeddingsGenerated: 0,
  };
}

function mergeStats(into: KnowledgeIndexStats, from: KnowledgeIndexStats): void {
  into.sourcesProcessed += from.sourcesProcessed;
  into.chunksIndexed += from.chunksIndexed;
  into.chunksSkipped += from.chunksSkipped;
  into.chunksDeleted += from.chunksDeleted;
  into.embeddingsGenerated += from.embeddingsGenerated;
}

async function upsertChunkWithEmbedding(
  chunk: KnowledgeDocumentChunk,
  contentHash: string,
  embedding: number[]
): Promise<void> {
  const id = crypto.randomUUID();
  const vector = embeddingToVectorLiteral(embedding);

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO chat_knowledge_chunks (
      id, "sourceType", "sourceId", "chunkIndex", title, path, text, "contentHash", embedding, "createdAt", "updatedAt"
    )
    VALUES (
      $1,
      $2::"ChatKnowledgeSourceType",
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9::vector,
      NOW(),
      NOW()
    )
    ON CONFLICT ("sourceType", "sourceId", "chunkIndex")
    DO UPDATE SET
      title = EXCLUDED.title,
      path = EXCLUDED.path,
      text = EXCLUDED.text,
      "contentHash" = EXCLUDED."contentHash",
      embedding = EXCLUDED.embedding,
      "updatedAt" = NOW()
    `,
    id,
    chunk.sourceType,
    chunk.sourceId,
    chunk.chunkIndex,
    chunk.title,
    chunk.path,
    chunk.text,
    contentHash,
    vector
  );
}

async function indexDocumentChunks(chunks: KnowledgeDocumentChunk[]): Promise<KnowledgeIndexStats> {
  const stats = emptyStats();

  if (chunks.length === 0) {
    return stats;
  }

  const { sourceType, sourceId } = chunks[0];
  stats.sourcesProcessed = 1;

  const existing = await prisma.chatKnowledgeChunk.findMany({
    where: { sourceType, sourceId },
    select: { chunkIndex: true, contentHash: true },
  });
  const hashByIndex = new Map(existing.map((row) => [row.chunkIndex, row.contentHash]));

  const toEmbed: KnowledgeDocumentChunk[] = [];
  const toEmbedHashes: string[] = [];

  for (const chunk of chunks) {
    const contentHash = hashContent(chunk.text);
    const previousHash = hashByIndex.get(chunk.chunkIndex);
    if (previousHash === contentHash) {
      stats.chunksSkipped += 1;
      continue;
    }
    toEmbed.push(chunk);
    toEmbedHashes.push(contentHash);
  }

  if (toEmbed.length > 0) {
    const embeddings = await embedTexts(toEmbed.map((c) => c.text));
    stats.embeddingsGenerated = embeddings.length;

    for (let i = 0; i < toEmbed.length; i += 1) {
      await upsertChunkWithEmbedding(toEmbed[i], toEmbedHashes[i], embeddings[i]);
      stats.chunksIndexed += 1;
    }
  }

  const maxIndex = chunks.length - 1;
  const deleted = await prisma.chatKnowledgeChunk.deleteMany({
    where: {
      sourceType,
      sourceId,
      chunkIndex: { gt: maxIndex },
    },
  });
  stats.chunksDeleted = deleted.count;

  return stats;
}

async function pruneOrphanSources(
  sourceType: ChatKnowledgeSourceType,
  validSourceIds: Set<string>
): Promise<number> {
  if (validSourceIds.size === 0) {
    const result = await prisma.chatKnowledgeChunk.deleteMany({ where: { sourceType } });
    return result.count;
  }

  const result = await prisma.chatKnowledgeChunk.deleteMany({
    where: {
      sourceType,
      sourceId: { notIn: [...validSourceIds] },
    },
  });
  return result.count;
}

async function collectChunks(
  sourceType: ChatKnowledgeSourceType,
  sourceId?: string
): Promise<KnowledgeDocumentChunk[]> {
  switch (sourceType) {
    case ChatKnowledgeSourceType.POLICY:
      return extractPolicyChunks();
    case ChatKnowledgeSourceType.PROGRAM:
      return sourceId ? extractProgramChunks(sourceId) : extractAllProgramChunks();
    case ChatKnowledgeSourceType.CAMP:
      return sourceId ? extractCampChunks(sourceId) : extractAllCampChunks();
    case ChatKnowledgeSourceType.CONSULTATION:
      return sourceId ? extractConsultationChunks(sourceId) : extractAllConsultationChunks();
    case ChatKnowledgeSourceType.BLOG:
      return sourceId ? extractBlogChunks(sourceId) : extractAllBlogChunks();
    case ChatKnowledgeSourceType.TESTIMONIAL:
      return sourceId ? extractTestimonialChunks(sourceId) : extractAllTestimonialChunks();
    case ChatKnowledgeSourceType.COMMUNITY:
      return sourceId ? extractCommunityChunks(sourceId) : extractAllCommunityChunks();
    default:
      throw new Error(`Unsupported knowledge source type: ${sourceType}`);
  }
}

async function listValidSourceIds(sourceType: ChatKnowledgeSourceType): Promise<Set<string>> {
  switch (sourceType) {
    case ChatKnowledgeSourceType.POLICY:
      return new Set([POLICY_SOURCE_ID]);
    case ChatKnowledgeSourceType.PROGRAM: {
      const rows = await prisma.program.findMany({
        where: { isPublished: true },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    }
    case ChatKnowledgeSourceType.CAMP: {
      const rows = await prisma.camp.findMany({ select: { id: true } });
      return new Set(rows.map((r) => r.id));
    }
    case ChatKnowledgeSourceType.CONSULTATION: {
      const rows = await prisma.consultationService.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    }
    case ChatKnowledgeSourceType.BLOG: {
      const rows = await prisma.blogPost.findMany({
        where: { isPublished: true },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    }
    case ChatKnowledgeSourceType.TESTIMONIAL: {
      const rows = await prisma.testimonial.findMany({
        where: { isPublished: true },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    }
    case ChatKnowledgeSourceType.COMMUNITY: {
      const rows = await prisma.community.findMany({
        where: { isPublished: true },
        select: { id: true },
      });
      return new Set(rows.map((r) => r.id));
    }
    default:
      return new Set();
  }
}

/** Index one source document or all documents of a type. */
export async function indexKnowledgeSource(
  sourceType: ChatKnowledgeSourceType,
  sourceId?: string
): Promise<KnowledgeIndexSourceResult> {
  const stats = emptyStats();

  if (sourceId) {
    const chunks = await collectChunks(sourceType, sourceId);
    if (chunks.length === 0) {
      const deleted = await prisma.chatKnowledgeChunk.deleteMany({
        where: { sourceType, sourceId },
      });
      stats.chunksDeleted = deleted.count;
      stats.sourcesProcessed = 1;
    } else {
      mergeStats(stats, await indexDocumentChunks(chunks));
    }
  } else {
    const chunks = await collectChunks(sourceType);
    const bySource = groupChunksBySourceId(chunks);

    for (const [, sourceChunks] of bySource) {
      mergeStats(stats, await indexDocumentChunks(sourceChunks));
    }

    const validIds = await listValidSourceIds(sourceType);
    stats.chunksDeleted += await pruneOrphanSources(sourceType, validIds);
    stats.sourcesProcessed = validIds.size;
  }

  return { sourceType, sourceId, ...stats };
}

/** Full rebuild across all knowledge source types. */
export async function indexAllKnowledge(): Promise<KnowledgeIndexStats> {
  const totals = emptyStats();
  const types = Object.values(ChatKnowledgeSourceType);

  for (const sourceType of types) {
    const result = await indexKnowledgeSource(sourceType);
    mergeStats(totals, result);
  }

  return totals;
}

function groupChunksBySourceId(
  chunks: KnowledgeDocumentChunk[]
): Map<string, KnowledgeDocumentChunk[]> {
  const map = new Map<string, KnowledgeDocumentChunk[]>();
  for (const chunk of chunks) {
    const list = map.get(chunk.sourceId) ?? [];
    list.push(chunk);
    map.set(chunk.sourceId, list);
  }
  for (const [key, list] of map) {
    map.set(
      key,
      list.sort((a, b) => a.chunkIndex - b.chunkIndex)
    );
  }
  return map;
}

/** Delete all indexed chunks for a removed/unpublished entity. */
export async function deleteKnowledgeSource(
  sourceType: ChatKnowledgeSourceType,
  sourceId: string
): Promise<number> {
  const result = await prisma.chatKnowledgeChunk.deleteMany({
    where: { sourceType, sourceId },
  });
  return result.count;
}

/** Count chunks currently stored (admin stats). */
export async function countKnowledgeChunks(
  where?: Prisma.ChatKnowledgeChunkWhereInput
): Promise<number> {
  return prisma.chatKnowledgeChunk.count({ where });
}

/** Latest update timestamp across the index. */
export async function getKnowledgeIndexLastUpdated(): Promise<Date | null> {
  const row = await prisma.chatKnowledgeChunk.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  return row?.updatedAt ?? null;
}

// Re-export for callers that index a single chunk text (e.g. tests)
export { embedText };
