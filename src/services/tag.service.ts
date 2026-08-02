import { Prisma, Tag, TagType } from '@prisma/client';
import prisma from '../config/prisma';
import { AppError } from '../middleware/error.middleware';

export const TAG_NAME_MAX = 60;
export const MAX_TAGS_PER_ENTITY = 20;

/**
 * Normalised dedupe key. "Career Exploration" and " career  exploration "
 * both collapse to "career-exploration" so the shared vocabulary does not
 * accumulate near-duplicates.
 */
export function slugifyTag(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Accepts an array, a JSON string of an array, or comma/newline-separated text
 * — multipart form fields arrive as any of these. Always returns string[].
 */
export function parseTagNameList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return parseTagNameList(raw.toString('utf8'));
  if (Array.isArray(raw)) {
    // A single-element array holding a JSON string, e.g. ['["a","b"]'].
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].trim().startsWith('[')) {
      return parseTagNameList(raw[0]);
    }
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      throw new AppError('tags must be a valid JSON array or a comma-separated list.', 400);
    }
  }
  return str
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertTagNameLength(name: string): void {
  if (name.length > TAG_NAME_MAX) {
    throw new AppError(`Each tag must be at most ${TAG_NAME_MAX} characters.`, 400);
  }
}

/**
 * Find-or-create every name against the shared vocabulary and return the rows
 * in the caller's original order (that order becomes the pill display order).
 *
 * Unknown names are added rather than rejected — tags are author-driven, not an
 * admin-curated list. `createMany({ skipDuplicates })` + `findMany` keeps this
 * race-safe under concurrent writes without per-row upsert round trips.
 */
export async function resolveTags(
  raw: unknown,
  type: TagType,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Tag[]> {
  const names = parseTagNameList(raw);
  if (names.length === 0) return [];
  if (names.length > MAX_TAGS_PER_ENTITY) {
    throw new AppError(`At most ${MAX_TAGS_PER_ENTITY} tags are allowed.`, 400);
  }

  // Dedupe by slug, keeping the first spelling and the caller's ordering.
  const firstSpellingBySlug = new Map<string, string>();
  for (const name of names) {
    assertTagNameLength(name);
    const slug = slugifyTag(name);
    if (!slug) continue; // e.g. "!!!" — nothing usable survives normalisation
    if (!firstSpellingBySlug.has(slug)) firstSpellingBySlug.set(slug, name);
  }

  const slugs = [...firstSpellingBySlug.keys()];
  if (slugs.length === 0) return [];

  await client.tag.createMany({
    data: slugs.map((slug) => ({ name: firstSpellingBySlug.get(slug)!, slug, type })),
    skipDuplicates: true,
  });

  const rows = await client.tag.findMany({ where: { type, slug: { in: slugs } } });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return slugs.map((slug) => bySlug.get(slug)).filter((t): t is Tag => Boolean(t));
}

/**
 * Resolve the single FORMAT tag for a consultation service.
 * Returns `undefined` when the caller omitted the field (leave unchanged),
 * `null` when it was explicitly cleared, otherwise the tag id.
 */
export async function resolveFormatTagId(raw: unknown): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;

  const name = String(raw).trim();
  assertTagNameLength(name);
  const slug = slugifyTag(name);
  if (!slug) {
    throw new AppError('format must contain at least one letter or number.', 400);
  }

  const [tag] = await resolveTags([name], TagType.FORMAT);
  return tag?.id ?? null;
}

// ── Per-entity sync ───────────────────────────────────────────────────────────
// PATCH semantics are handled by the caller: only invoke these when the field
// was actually present on the request. Passing an empty list clears all tags.

export async function syncProgramTags(programId: string, raw: unknown): Promise<Tag[]> {
  const tags = await resolveTags(raw, TagType.TOPIC);
  await prisma.$transaction([
    prisma.programTag.deleteMany({ where: { programId } }),
    ...(tags.length
      ? [
          prisma.programTag.createMany({
            data: tags.map((tag, index) => ({ programId, tagId: tag.id, order: index })),
          }),
        ]
      : []),
  ]);
  return tags;
}

export async function syncConsultationServiceTags(
  serviceId: string,
  raw: unknown
): Promise<Tag[]> {
  const tags = await resolveTags(raw, TagType.TOPIC);
  await prisma.$transaction([
    prisma.consultationServiceTag.deleteMany({ where: { serviceId } }),
    ...(tags.length
      ? [
          prisma.consultationServiceTag.createMany({
            data: tags.map((tag, index) => ({ serviceId, tagId: tag.id, order: index })),
          }),
        ]
      : []),
  ]);
  return tags;
}

export async function syncCommunityTags(communityId: string, raw: unknown): Promise<Tag[]> {
  const tags = await resolveTags(raw, TagType.TOPIC);
  await prisma.$transaction([
    prisma.communityTag.deleteMany({ where: { communityId } }),
    ...(tags.length
      ? [
          prisma.communityTag.createMany({
            data: tags.map((tag, index) => ({ communityId, tagId: tag.id, order: index })),
          }),
        ]
      : []),
  ]);
  return tags;
}

// ── Listing ───────────────────────────────────────────────────────────────────

export function parseTagType(raw: unknown, required = false): TagType | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new AppError('type is required.', 400);
    return undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (!Object.values(TagType).includes(s as TagType)) {
    throw new AppError(`type must be one of: ${Object.values(TagType).join(', ')}.`, 400);
  }
  return s as TagType;
}

export async function listTags(opts: { type?: TagType; search?: string }): Promise<Tag[]> {
  const { type, search } = opts;
  return prisma.tag.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(search && search.length > 0
        ? { name: { contains: search, mode: 'insensitive' as const } }
        : {}),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
}
