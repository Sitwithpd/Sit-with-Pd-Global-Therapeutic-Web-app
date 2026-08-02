import { withSerializedTags } from './serializeTags';

/**
 * Removes the WhatsApp group link from any payload leaving a public route.
 *
 * The link is the whole value of a community membership — anyone holding it can
 * join without applying. It is emailed to applicants and shown to admins, and
 * must never appear in a public response body or in the chat knowledge index.
 * Every public community handler routes through this function rather than
 * hand-rolling a `select`, so a newly added field cannot leak it by omission.
 */
export function toPublicCommunity<C extends { whatsappLink?: string | null }>(
  community: C
): Omit<C, 'whatsappLink'> {
  const { whatsappLink: _secretGroupLink, ...rest } = community;
  return rest;
}

/** Public shape: tags flattened, group link stripped. */
export function toPublicCommunityWithTags<
  C extends { whatsappLink?: string | null; tags?: Parameters<typeof withSerializedTags>[0]['tags'] }
>(community: C) {
  return toPublicCommunity(withSerializedTags(community));
}
