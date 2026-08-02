import { Request, Response } from 'express';
import { catchAsync } from '../middleware/error.middleware';
import { listTags, parseTagType } from '../services/tag.service';

const TAG_SEARCH_MAX_LEN = 60;

/**
 * GET /api/tags?type=TOPIC&search=car
 * Public: feeds the tag autocomplete in the admin create/edit forms.
 * Tag names are non-sensitive display strings, so no auth gate.
 */
export const getTags = catchAsync(async (req: Request, res: Response) => {
  const type = parseTagType(req.query.type, false);
  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string' ? rawSearch.trim().slice(0, TAG_SEARCH_MAX_LEN) : '';

  const tags = await listTags({ type, search });

  res.json({ success: true, message: 'Tags fetched.', data: tags });
});
