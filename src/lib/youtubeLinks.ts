import { AppError } from '../middleware/error.middleware';

export const MAX_VIDEO_LINKS = 12;

/** YouTube ids are 11 chars from a URL-safe alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * Pulls the video id out of any of the shapes YouTube hands out:
 *   youtube.com/watch?v=ID      youtu.be/ID
 *   youtube.com/embed/ID        youtube.com/shorts/ID
 *   youtube.com/live/ID         youtube.com/v/ID
 * Returns null when the URL is not a recognisable YouTube video.
 */
export function extractYouTubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/ID — the id is the whole path.
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && VIDEO_ID.test(id) ? id : null;
  }

  // watch?v=ID (also covers /watch?v=ID&list=... playlists)
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return v;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length >= 2) {
    const [prefix, candidate] = segments;
    if (['embed', 'shorts', 'live', 'v'].includes(prefix.toLowerCase())) {
      return VIDEO_ID.test(candidate) ? candidate : null;
    }
  }

  return null;
}

/** Canonical stored form, so the same video is never stored two ways. */
export function canonicalYouTubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Accepts an array, a JSON string of an array, or newline/comma separated
 * text — multipart form fields arrive as any of these.
 */
function splitRawLinks(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return splitRawLinks(raw.toString('utf8'));
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].trim().startsWith('[')) {
      return splitRawLinks(raw[0].trim());
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
      throw new AppError('videoLinks must be a valid JSON array of YouTube URLs.', 400);
    }
  }
  return str
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validates and canonicalises a list of YouTube links, preserving the caller's
 * order — the array index IS the display order.
 *
 * Rejects non-YouTube URLs loudly rather than storing something that will not
 * embed, and drops duplicates (keeping the first position) so the same video
 * cannot appear twice in one carousel.
 */
export function parseVideoLinks(raw: unknown, field = 'videoLinks'): string[] {
  const candidates = splitRawLinks(raw);
  if (candidates.length === 0) return [];
  if (candidates.length > MAX_VIDEO_LINKS) {
    throw new AppError(`At most ${MAX_VIDEO_LINKS} video links are allowed.`, 400);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const id = extractYouTubeId(candidate);
    if (!id) {
      throw new AppError(
        `${field} must contain YouTube video URLs only. "${candidate.slice(0, 80)}" is not one.`,
        400
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(canonicalYouTubeUrl(id));
  }
  return out;
}
