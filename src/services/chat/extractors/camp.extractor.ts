import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

function formatList(label: string, items: string[]): string {
  if (items.length === 0) return '';
  return `${label}:\n${items.map((i) => `- ${i}`).join('\n')}`;
}

export async function extractCampChunks(campId: string): Promise<KnowledgeDocumentChunk[]> {
  const camp = await prisma.camp.findUnique({
    where: { id: campId },
    include: {
      tiers: { orderBy: { order: 'asc' } },
    },
  });

  if (!camp) return [];

  const path = CHAT_FRONTEND_PATHS.campDetail(camp.id);
  const overview = [
    `Camp: ${camp.title}`,
    `Status: ${camp.status}`,
    camp.category ? `Category: ${camp.category}` : '',
    `Location: ${camp.location}`,
    `Dates: ${camp.startDate.toISOString().slice(0, 10)} to ${camp.endDate.toISOString().slice(0, 10)}`,
    `Currency: ${camp.currency}`,
    `Capacity: ${camp.capacity} seats`,
    '',
    camp.description,
    '',
    formatList('Why attend', camp.benefits),
  ]
    .filter(Boolean)
    .join('\n');

  const chunks: KnowledgeDocumentChunk[] = [
    {
      sourceType: ChatKnowledgeSourceType.CAMP,
      sourceId: camp.id,
      chunkIndex: 0,
      title: camp.title,
      path,
      text: overview,
    },
  ];

  camp.tiers.forEach((tier, idx) => {
    const tierText = [
      `Camp: ${camp.title}`,
      `Tier: ${tier.label}`,
      tier.description ?? '',
      `Price: ${tier.price} ${camp.currency}`,
      `Seats per registration: ${tier.seatsPerUnit}`,
      tier.maxUnits != null ? `Maximum units available: ${tier.maxUnits}` : null,
      tier.isFeatured ? 'Featured tier on the camp page.' : null,
      '',
      formatList('Inclusions', tier.inclusions),
    ]
      .filter(Boolean)
      .join('\n');

    chunks.push({
      sourceType: ChatKnowledgeSourceType.CAMP,
      sourceId: camp.id,
      chunkIndex: idx + 1,
      title: `${camp.title} — ${tier.label}`,
      path,
      text: tierText,
    });
  });

  return chunks;
}

export async function extractAllCampChunks(): Promise<KnowledgeDocumentChunk[]> {
  const camps = await prisma.camp.findMany({
    select: { id: true },
    orderBy: { startDate: 'desc' },
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of camps) {
    all.push(...(await extractCampChunks(id)));
  }
  return all;
}
