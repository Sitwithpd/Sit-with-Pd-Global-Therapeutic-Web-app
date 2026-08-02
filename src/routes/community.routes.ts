import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createCommunity,
  deleteCommunity,
  getCommunities,
  getCommunitiesAdmin,
  getCommunityAdminById,
  getCommunityByIdOrSlug,
  getJoinRequestsAdmin,
  joinCommunity,
  resendJoinRequestInvite,
  updateCommunity,
} from '../controllers/community.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';

const router = Router();

/**
 * Join is unauthenticated and causes mail to be sent to a caller-supplied
 * address, so it gets its own tight budget. Kept off the read routes, which are
 * hit on every page load and only carry the global limiter.
 */
const communityJoinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Too many join requests. Please try again later.',
  },
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// Declared before /:idOrSlug so "admin" is not captured as a slug.
router.get('/admin/all', authenticate, adminOnly, getCommunitiesAdmin);
router.get('/admin/join-requests', authenticate, adminOnly, getJoinRequestsAdmin);
router.post(
  '/admin/join-requests/:id/resend',
  authenticate,
  adminOnly,
  resendJoinRequestInvite
);
router.get('/admin/:id', authenticate, adminOnly, getCommunityAdminById);

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', getCommunities);
router.get('/:idOrSlug', getCommunityByIdOrSlug);
router.post('/:idOrSlug/join', communityJoinLimiter, joinCommunity);

// ── Admin: CRUD ───────────────────────────────────────────────────────────────
router.post('/', authenticate, adminOnly, createCommunity);
router.patch('/:id', authenticate, adminOnly, updateCommunity);
router.delete('/:id', authenticate, adminOnly, deleteCommunity);

export default router;
