import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

export async function extractConsultationChunks(serviceId: string): Promise<KnowledgeDocumentChunk[]> {
  const service = await prisma.consultationService.findFirst({
    where: { id: serviceId, isActive: true },
    include: {
      formatTag: true,
      tags: { include: { tag: true }, orderBy: { order: 'asc' } },
    },
  });

  if (!service) return [];

  const topics = service.tags.map((t) => t.tag?.name).filter(Boolean);
  const bullets = (label: string, items: string[]) =>
    items.length > 0 ? `\n${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';

  const text = [
    `Consultation service: ${service.title}`,
    `Duration: ${service.duration} minutes`,
    `Price: ${service.price} ${service.currency}`,
    service.formatTag ? `Format: ${service.formatTag.name}` : '',
    topics.length > 0 ? `Topics: ${topics.join(', ')}` : '',
    '',
    service.description,
    bullets("Who it's for", service.audience),
    bullets("What's included", service.whatsIncluded),
    service.calBookingUrl ? `\nBook online: ${service.calBookingUrl}` : '',
    `\nBrowse all services: ${CHAT_FRONTEND_PATHS.consultations}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      sourceType: ChatKnowledgeSourceType.CONSULTATION,
      sourceId: service.id,
      chunkIndex: 0,
      title: service.title,
      path: CHAT_FRONTEND_PATHS.consultations,
      text,
    },
  ];
}

export async function extractAllConsultationChunks(): Promise<KnowledgeDocumentChunk[]> {
  const services = await prisma.consultationService.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of services) {
    all.push(...(await extractConsultationChunks(id)));
  }
  return all;
}
