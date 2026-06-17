import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

export async function extractConsultationChunks(serviceId: string): Promise<KnowledgeDocumentChunk[]> {
  const service = await prisma.consultationService.findFirst({
    where: { id: serviceId, isActive: true },
  });

  if (!service) return [];

  const text = [
    `Consultation service: ${service.title}`,
    `Duration: ${service.duration} minutes`,
    `Price: ${service.price} ${service.currency}`,
    '',
    service.description,
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
