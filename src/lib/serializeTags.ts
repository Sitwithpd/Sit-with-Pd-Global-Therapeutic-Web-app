import { TagType } from '@prisma/client';

/**
 * Flattens the explicit join-table shape (`entity.tags[].tag`) into the flat
 * array the frontend renders. Applied at the controller boundary so no route
 * ever leaks `{ tag: { ... } }` wrappers into a response.
 */
export interface SerializedTag {
  id: string;
  name: string;
  slug: string;
  type: TagType;
}

interface TagJoinRow {
  order?: number;
  tag: { id: string; name: string; slug: string; type: TagType } | null;
}

export function serializeTags(joins?: TagJoinRow[] | null): SerializedTag[] {
  if (!joins?.length) return [];
  return [...joins]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((join) => join.tag)
    .filter((tag): tag is NonNullable<TagJoinRow['tag']> => Boolean(tag))
    .map((tag) => ({ id: tag.id, name: tag.name, slug: tag.slug, type: tag.type }));
}

/** Prisma `include` fragment — keeps join ordering consistent across controllers. */
export const tagJoinInclude = {
  include: { tag: true },
  orderBy: { order: 'asc' as const },
} as const;

/**
 * Replaces an entity's join rows with the flat `tags` array in place.
 * Generic over the entity so callers keep their own field typing.
 */
export function withSerializedTags<T extends { tags?: TagJoinRow[] | null }>(
  entity: T
): Omit<T, 'tags'> & { tags: SerializedTag[] } {
  const { tags, ...rest } = entity;
  return { ...rest, tags: serializeTags(tags) };
}

/**
 * Consultation services additionally carry a single FORMAT tag via FK.
 * Exposed as `format: { id, name } | null` alongside the flat topic `tags`.
 */
export function serializeFormatTag(
  formatTag?: { id: string; name: string; slug: string; type: TagType } | null
): SerializedTag | null {
  if (!formatTag) return null;
  return {
    id: formatTag.id,
    name: formatTag.name,
    slug: formatTag.slug,
    type: formatTag.type,
  };
}
