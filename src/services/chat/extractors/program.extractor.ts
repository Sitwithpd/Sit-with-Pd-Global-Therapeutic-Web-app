import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';
import { ChatKnowledgeSourceType } from '@prisma/client';
import { chunkPlainText } from '../chunkText.service';

function formatList(label: string, items: string[]): string {
  if (items.length === 0) return '';
  return `${label}:\n${items.map((i) => `- ${i}`).join('\n')}`;
}

function buildProgramOverviewText(program: {
  title: string;
  description: string;
  category: string;
  price: number;
  currency: string;
  durationWeeks: number | null;
  hoursPerWeek: number | null;
  certificateLabel: string | null;
  learningOutcomes: string[];
  audience: string[];
  topics: string[];
  facilitatorName: string | null;
  startDate: Date | null;
}): string {
  const lines = [
    `Program: ${program.title}`,
    `Category: ${program.category}`,
    program.topics.length > 0 ? `Topics: ${program.topics.join(', ')}` : null,
    `Price: ${program.price} ${program.currency}`,
    program.durationWeeks != null ? `Duration: ${program.durationWeeks} weeks` : null,
    program.hoursPerWeek != null ? `Hours per week: ${program.hoursPerWeek}` : null,
    program.certificateLabel ? `Certificate: ${program.certificateLabel}` : null,
    program.facilitatorName ? `Facilitator: ${program.facilitatorName}` : null,
    program.startDate ? `Start date: ${program.startDate.toISOString().slice(0, 10)}` : null,
    '',
    program.description,
    '',
    formatList("Who this is for", program.audience),
    formatList('Learning outcomes', program.learningOutcomes),
  ];
  return lines.filter((l) => l !== null && l !== '').join('\n');
}

export async function extractProgramChunks(programId: string): Promise<KnowledgeDocumentChunk[]> {
  const program = await prisma.program.findFirst({
    where: { id: programId, isPublished: true },
    include: {
      tags: { include: { tag: true }, orderBy: { order: 'asc' } },
      weeks: {
        orderBy: { order: 'asc' },
        include: {
          modules: {
            orderBy: { order: 'asc' },
            select: {
              title: true,
              description: true,
              type: true,
              duration: true,
              order: true,
            },
          },
        },
      },
    },
  });

  if (!program) return [];

  const path = CHAT_FRONTEND_PATHS.programDetail(program.id);
  const chunks: KnowledgeDocumentChunk[] = [
    {
      sourceType: ChatKnowledgeSourceType.PROGRAM,
      sourceId: program.id,
      chunkIndex: 0,
      title: program.title,
      path,
      text: buildProgramOverviewText({
        ...program,
        topics: program.tags.map((t) => t.tag?.name).filter((n): n is string => Boolean(n)),
      }),
    },
  ];

  for (const week of program.weeks) {
    const moduleLines = week.modules.map((mod) => {
      const bits = [`${mod.order + 1}. ${mod.title} (${mod.type})`];
      if (mod.duration) bits.push(`Duration: ${mod.duration}`);
      if (mod.description) bits.push(mod.description);
      return bits.join(' — ');
    });

    const weekText = [
      `Program: ${program.title}`,
      `Week ${week.order}: ${week.title}`,
      week.description ?? '',
      formatList('Week learning objectives', week.learningObjectives),
      moduleLines.length > 0 ? formatList('Modules', moduleLines) : '',
    ]
      .filter(Boolean)
      .join('\n');

    for (const text of chunkPlainText(weekText)) {
      chunks.push({
        sourceType: ChatKnowledgeSourceType.PROGRAM,
        sourceId: program.id,
        chunkIndex: 0,
        title: `${program.title} — ${week.title}`,
        path,
        text,
      });
    }
  }

  return reindexChunkIndices(chunks);
}

export async function extractAllProgramChunks(): Promise<KnowledgeDocumentChunk[]> {
  const programs = await prisma.program.findMany({
    where: { isPublished: true },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of programs) {
    all.push(...(await extractProgramChunks(id)));
  }
  return all;
}

function reindexChunkIndices(chunks: KnowledgeDocumentChunk[]): KnowledgeDocumentChunk[] {
  return chunks.map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));
}
