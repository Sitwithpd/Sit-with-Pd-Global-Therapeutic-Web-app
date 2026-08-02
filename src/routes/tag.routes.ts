import { Router } from 'express';
import { getTags } from '../controllers/tag.controller';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', getTags);

export default router;
