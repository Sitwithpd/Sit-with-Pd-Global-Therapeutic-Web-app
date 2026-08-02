import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

/**
 * Indexes a community so the assistant can describe it and point people at the
 * public page to apply.
 *
 * SECURITY: `whatsappLink` is deliberately never read into the chunk text.
 * Retrieved chunks are pasted verbatim into the model prompt and surface to any
 * visitor who asks a similar-enough question — indexing the invite would hand
 * out group access to people who never applied. The `select` below is an
 * allow-list rather than a `findUnique()` spread so that adding a secret field
 * to the model in future cannot silently leak it here.
 */
export async function extractCommunityChunks(
  communityId: string
): Promise<KnowledgeDocumentChunk[]> {
  const community = await prisma.community.findFirst({
    where: { id: communityId, isPublished: true },
    select: {
      id: true,
      title: true,
      slug: true,
      subtitle: true,
      description: true,
      gains: true,
      tags: { select: { tag: { select: { name: true } } }, orderBy: { order: 'asc' } },
      // whatsappLink intentionally omitted — see the note above.
    },
  });

  if (!community) return [];

  const topics = community.tags.map((t) => t.tag?.name).filter(Boolean);
  const path = CHAT_FRONTEND_PATHS.community;

  const text = [
    `Community: ${community.title}`,
    community.subtitle,
    '',
    community.description,
    community.gains.length ? `\nWhat you'll gain:\n${community.gains.map((g) => `- ${g}`).join('\n')}` : '',
    topics.length ? `\nPopular topics: ${topics.join(', ')}` : '',
    `\nApply to join from the community page: ${path}`,
    'Members receive the group invite by email once they apply.',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      sourceType: ChatKnowledgeSourceType.COMMUNITY,
      sourceId: community.id,
      chunkIndex: 0,
      title: community.title,
      path,
      text,
    },
  ];
}

export async function extractAllCommunityChunks(): Promise<KnowledgeDocumentChunk[]> {
  const communities = await prisma.community.findMany({
    where: { isPublished: true },
    select: { id: true },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of communities) {
    all.push(...(await extractCommunityChunks(id)));
  }
  return all;
}
