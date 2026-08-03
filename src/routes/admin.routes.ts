import { Router } from 'express';
import { body } from 'express-validator';
import {
  getDashboard,
  getProgramContent,
  completeProgramModule,
} from '../controllers/dashboard.controller';
import { contactDashboardSupport, contactProgramFacilitator } from '../controllers/dashboardSupport.controller';
import {
  getDashboardStats,
  getAllUsers,
  getUserById,
  getCalEventTypes,
} from '../controllers/admin.controller';
import { adminListNewsletterSubscriptions } from '../controllers/newsletter.controller';
import {
  adminDeleteContactSubmission,
  adminListContactSubmissions,
} from '../controllers/contact.controller';
import {
  getAdminPlatformSettings,
  patchAdminGeneralSettings,
  patchAdminFeaturesSettings,
  patchAdminNotificationsSettings,
} from '../controllers/adminSettings.controller';
import {
  adminListBlogPosts,
  getBlogPostByIdAdmin,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from '../controllers/blog.controller';
import {
  adminGetChatStats,
  adminReindexChatKnowledge,
} from '../controllers/adminChat.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';
import { enforceVerifiedEmailIfRequired } from '../middleware/platformSettings.middleware';
import { validate } from '../middleware/validate.middleware';
import { uploadImage } from '../middleware/upload.middleware';
import { isValidIanaTimezone } from '../lib/timezone';
import {
  getFxRates,
  getSupportedCurrencies,
  overrideFxRate,
  triggerFxSync,
  updateSupportedCurrency,
} from '../controllers/adminFx.controller';

// ── User Dashboard ────────────────────────────────────────────────────────────
export const dashboardRouter = Router();

dashboardRouter.get('/', authenticate, enforceVerifiedEmailIfRequired, getDashboard);
dashboardRouter.get(
  '/programs/:programId',
  authenticate,
  enforceVerifiedEmailIfRequired,
  getProgramContent
);
dashboardRouter.post(
  '/programs/:programId/modules/:moduleId/complete',
  authenticate,
  enforceVerifiedEmailIfRequired,
  completeProgramModule
);

const dashboardMessageValidators = [
  body('message')
    .trim()
    .isLength({ min: 10, max: 4000 })
    .withMessage('message must be between 10 and 4000 characters.'),
  body('subject')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 200 })
    .withMessage('subject max 200 characters.'),
];

dashboardRouter.post(
  '/support/contact',
  authenticate,
  enforceVerifiedEmailIfRequired,
  dashboardMessageValidators,
  validate,
  contactDashboardSupport
);

dashboardRouter.post(
  '/programs/:programId/contact-facilitator',
  authenticate,
  enforceVerifiedEmailIfRequired,
  dashboardMessageValidators,
  validate,
  contactProgramFacilitator
);

// ── Admin Routes ──────────────────────────────────────────────────────────────
export const adminRouter = Router();

adminRouter.get('/stats', authenticate, adminOnly, getDashboardStats);

adminRouter.get('/fx/rates', authenticate, adminOnly, getFxRates);
adminRouter.post('/fx/rates', authenticate, adminOnly, overrideFxRate);
adminRouter.post('/fx/sync', authenticate, adminOnly, triggerFxSync);
adminRouter.get('/currencies', authenticate, adminOnly, getSupportedCurrencies);
adminRouter.patch('/currencies/:code', authenticate, adminOnly, updateSupportedCurrency);
adminRouter.get('/settings', authenticate, adminOnly, getAdminPlatformSettings);

adminRouter.patch(
  '/settings/general',
  authenticate,
  adminOnly,
  [
    body('platformName').optional().trim().notEmpty().withMessage('platformName cannot be empty.'),
    body('supportEmail').optional().isEmail().withMessage('Valid supportEmail is required.'),
    body('defaultTimezone').optional().custom((v: string) => {
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error('defaultTimezone cannot be empty when provided.');
      }
      if (!isValidIanaTimezone(v.trim())) throw new Error('Invalid IANA timezone.');
      return true;
    }),
    body('currency').optional().isIn(['NGN', 'USD', 'EUR', 'GBP']).withMessage('Invalid currency.'),
  ],
  validate,
  patchAdminGeneralSettings
);

adminRouter.patch(
  '/settings/features',
  authenticate,
  adminOnly,
  [
    body('maintenanceMode').optional().isBoolean().withMessage('maintenanceMode must be a boolean.'),
    body('allowUserRegistration').optional().isBoolean().withMessage('allowUserRegistration must be a boolean.'),
    body('requireEmailVerification')
      .optional()
      .isBoolean()
      .withMessage('requireEmailVerification must be a boolean.'),
    body('autoEnrollment').optional().isBoolean().withMessage('autoEnrollment must be a boolean.'),
  ],
  validate,
  patchAdminFeaturesSettings
);

adminRouter.patch(
  '/settings/notifications',
  authenticate,
  adminOnly,
  [
    body('emailNotificationsEnabled')
      .isBoolean()
      .withMessage('emailNotificationsEnabled must be a boolean.'),
  ],
  validate,
  patchAdminNotificationsSettings
);

adminRouter.get('/users', authenticate, adminOnly, getAllUsers);
adminRouter.get('/users/:id', authenticate, adminOnly, getUserById);
adminRouter.get(
  '/newsletter/subscriptions',
  authenticate,
  adminOnly,
  adminListNewsletterSubscriptions
);
adminRouter.get(
  '/contact-submissions',
  authenticate,
  adminOnly,
  adminListContactSubmissions
);
adminRouter.delete(
  '/contact-submissions/:id',
  authenticate,
  adminOnly,
  adminDeleteContactSubmission
);
adminRouter.get('/cal/event-types', authenticate, adminOnly, getCalEventTypes);

adminRouter.post('/chat/reindex', authenticate, adminOnly, adminReindexChatKnowledge);
adminRouter.get('/chat/stats', authenticate, adminOnly, adminGetChatStats);

// Blog (drafts + CRUD — public reads are on /api/blog)
adminRouter.get('/blog', authenticate, adminOnly, adminListBlogPosts);
adminRouter.get('/blog/:id', authenticate, adminOnly, getBlogPostByIdAdmin);
adminRouter.post(
  '/blog',
  authenticate,
  adminOnly,
  uploadImage.single('coverImage'),
  createBlogPost
);
adminRouter.patch(
  '/blog/:id',
  authenticate,
  adminOnly,
  uploadImage.single('coverImage'),
  updateBlogPost
);
adminRouter.delete('/blog/:id', authenticate, adminOnly, deleteBlogPost);
