import { Router } from 'express';
import {
  getAllCamps,
  getAllCampsAdmin,
  getCurrentCamp,
  getCampById,
  registerForCamp,
  createCamp,
  updateCamp,
  deleteCamp,
  getCampParticipants,
  getMyCampRegistrations,
  createCampTier,
  updateCampTier,
  deleteCampTier,
  uploadCampImages,
  updateCampImage,
  deleteCampImage,
} from '../controllers/camp.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';
import { enforceVerifiedEmailIfRequired } from '../middleware/platformSettings.middleware';
import { uploadImage } from '../middleware/upload.middleware';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
// Declare /current and /admin/all before /:id so they aren't captured by the param route.
router.get('/current', getCurrentCamp);
router.get('/admin/all', authenticate, adminOnly, getAllCampsAdmin);
router.get('/', getAllCamps);
router.get('/:id', getCampById);

// ── User ──────────────────────────────────────────────────────────────────────
router.post('/:id/register', authenticate, enforceVerifiedEmailIfRequired, registerForCamp);
// Plural: a user may hold several units for one camp.
router.get('/:id/my-registrations', authenticate, getMyCampRegistrations);
router.get('/:id/my-registration', authenticate, getMyCampRegistrations);

// ── Admin: Camp CRUD ──────────────────────────────────────────────────────────
router.post('/', authenticate, adminOnly, uploadImage.single('thumbnail'), createCamp);
router.patch('/:id', authenticate, adminOnly, uploadImage.single('thumbnail'), updateCamp);
router.delete('/:id', authenticate, adminOnly, deleteCamp);
router.get('/:id/participants', authenticate, adminOnly, getCampParticipants);

// ── Admin: Tiers (Individual / Couple / Family packages) ─────────────────────
router.post('/:campId/tiers', authenticate, adminOnly, createCampTier);
router.patch('/:campId/tiers/:tierId', authenticate, adminOnly, updateCampTier);
router.delete('/:campId/tiers/:tierId', authenticate, adminOnly, deleteCampTier);

// ── Admin: Gallery images ─────────────────────────────────────────────────────
router.post(
  '/:campId/images',
  authenticate,
  adminOnly,
  uploadImage.array('images', 12),
  uploadCampImages
);
router.patch('/:campId/images/:imageId', authenticate, adminOnly, updateCampImage);
router.delete('/:campId/images/:imageId', authenticate, adminOnly, deleteCampImage);

export default router;
