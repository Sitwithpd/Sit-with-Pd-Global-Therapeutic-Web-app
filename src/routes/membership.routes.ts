import { Router } from 'express';
import {
  getPlans,
  getPlanById,
  getMySubscription,
  getMySubscriptionPayments,
  cancelMySubscription,
  resumeMySubscription,
  changeMyPlan,
  cancelScheduledChange,
  subscribe,
  getPlansAdmin,
  createPlan,
  updatePlan,
  deletePlan,
  getSubscribersAdmin,
  getMembershipStats,
} from '../controllers/membership.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';
import { enforceVerifiedEmailIfRequired } from '../middleware/platformSettings.middleware';

const router = Router();

// ── Admin ─────────────────────────────────────────────────────────────────────
// Registered before `/plans/:id` so "admin" is never read as a plan id.
router.get('/admin/plans', authenticate, adminOnly, getPlansAdmin);
router.post('/admin/plans', authenticate, adminOnly, createPlan);
router.patch('/admin/plans/:id', authenticate, adminOnly, updatePlan);
router.delete('/admin/plans/:id', authenticate, adminOnly, deletePlan);
router.get('/admin/subscribers', authenticate, adminOnly, getSubscribersAdmin);
router.get('/admin/stats', authenticate, adminOnly, getMembershipStats);

// ── Member ────────────────────────────────────────────────────────────────────
router.get('/me', authenticate, getMySubscription);
router.get('/me/payments', authenticate, getMySubscriptionPayments);
router.post('/me/cancel', authenticate, cancelMySubscription);
router.post('/me/resume', authenticate, resumeMySubscription);
router.post('/me/change', authenticate, changeMyPlan);
router.delete('/me/change', authenticate, cancelScheduledChange);
router.post('/subscribe', authenticate, enforceVerifiedEmailIfRequired, subscribe);

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/plans', getPlans);
router.get('/plans/:id', getPlanById);

export default router;
