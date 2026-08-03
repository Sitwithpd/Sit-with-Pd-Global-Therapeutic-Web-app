import { Router } from 'express';
import {
  getServices,
  getServiceById,
  adminManualBookConsultation,
  getMyConsultations,
  getAllConsultations,
  getAllServicesAdmin,
  updateConsultation,
  createService,
  updateService,
} from '../controllers/consultation.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';
import { enforceVerifiedEmailIfRequired } from '../middleware/platformSettings.middleware';
import { uploadImage } from '../middleware/upload.middleware';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/services', getServices);
router.get('/services/:id', getServiceById);

// ── User ──────────────────────────────────────────────────────────────────────
router.get('/my', authenticate, enforceVerifiedEmailIfRequired, getMyConsultations);

// ── Admin: manual booking (no Cal.com) ─────────────────────────────────────────
router.post('/book', authenticate, adminOnly, adminManualBookConsultation);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/services', authenticate, adminOnly, getAllServicesAdmin);
router.get('/', authenticate, adminOnly, getAllConsultations);
router.patch('/:id', authenticate, adminOnly, updateConsultation);
// `coverImage` is an optional file upload. multer also parses multipart text
// fields; JSON bodies still work and may pass `coverImageUrl` as a string.
router.post(
  '/services',
  authenticate,
  adminOnly,
  uploadImage.single('coverImage'),
  createService
);
router.patch(
  '/services/:id',
  authenticate,
  adminOnly,
  uploadImage.single('coverImage'),
  updateService
);

export default router;
