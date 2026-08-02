import { ChatKnowledgeSourceType } from '@prisma/client';
import {
  deleteKnowledgeSource,
  indexKnowledgeSource,
} from './knowledgeIndex.service';
import { POLICY_SOURCE_ID } from './extractors/policy.extractor';

function logReindexError(action: string, err: unknown): void {
  console.warn(`[chat-reindex] ${action} failed:`, err);
}

/** Fire-and-forget partial reindex for one indexed document. */
export function scheduleChatReindexSource(
  sourceType: ChatKnowledgeSourceType,
  sourceId: string
): void {
  void indexKnowledgeSource(sourceType, sourceId).catch((err) =>
    logReindexError(`${sourceType}:${sourceId}`, err)
  );
}

/** Fire-and-forget removal of all chunks for a deleted entity. */
export function scheduleChatDeleteSource(
  sourceType: ChatKnowledgeSourceType,
  sourceId: string
): void {
  void deleteKnowledgeSource(sourceType, sourceId).catch((err) =>
    logReindexError(`delete ${sourceType}:${sourceId}`, err)
  );
}

export function scheduleChatReindexProgram(programId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.PROGRAM, programId);
}

export function scheduleChatReindexCamp(campId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.CAMP, campId);
}

export function scheduleChatReindexBlogPost(postId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.BLOG, postId);
}

export function scheduleChatReindexConsultationService(serviceId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.CONSULTATION, serviceId);
}

export function scheduleChatReindexTestimonial(testimonialId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.TESTIMONIAL, testimonialId);
}

export function scheduleChatReindexCommunity(communityId: string): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.COMMUNITY, communityId);
}

export function scheduleChatReindexPolicy(): void {
  scheduleChatReindexSource(ChatKnowledgeSourceType.POLICY, POLICY_SOURCE_ID);
}

export function scheduleChatDeleteProgram(programId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.PROGRAM, programId);
}

export function scheduleChatDeleteCamp(campId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.CAMP, campId);
}

export function scheduleChatDeleteBlogPost(postId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.BLOG, postId);
}

export function scheduleChatDeleteConsultationService(serviceId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.CONSULTATION, serviceId);
}

export function scheduleChatDeleteTestimonial(testimonialId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.TESTIMONIAL, testimonialId);
}

export function scheduleChatDeleteCommunity(communityId: string): void {
  scheduleChatDeleteSource(ChatKnowledgeSourceType.COMMUNITY, communityId);
}
