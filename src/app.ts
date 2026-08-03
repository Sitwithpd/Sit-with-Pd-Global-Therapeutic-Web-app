import express, { raw } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import 'dotenv/config';

import authRoutes from './routes/auth.routes';
import programRoutes from './routes/program.routes';
import campRoutes from './routes/camp.routes';
import testimonialRoutes from './routes/testimonial.routes';
import consultationRoutes from './routes/consultation.routes';
import paymentRoutes from './routes/payment.routes';
import blogRoutes from './routes/blog.routes';
import newsletterRoutes from './routes/newsletter.routes';
import contactRoutes from './routes/contact.routes';
import teamRoutes from './routes/team.routes';
import tagRoutes from './routes/tag.routes';
import communityRoutes from './routes/community.routes';
import chatRoutes from './routes/chat.routes';
import { dashboardRouter, adminRouter } from './routes/admin.routes';
import { errorHandler } from './middleware/error.middleware';
import { resolveCurrency } from './middleware/currency.middleware';
import { calWebhook } from './controllers/consultation.cal.controller';
import { flutterwaveWebhook } from './controllers/payment.controller';
import { processExpiredConsultationPayments } from './services/consultationExpiry.service';
import { processExpiredCampRegistrations } from './services/campRegistrationExpiry.service';
import { processCampStatusTransitions } from './services/campStatus.service';
import { cronReindexChatKnowledge } from './controllers/adminChat.controller';
import { runFxSync } from './services/fx/fxSync.job';

const app = express();
app.set('trust proxy', 1);

// BigInt money columns would otherwise throw inside res.json().
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? Number(value) : value
);


// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());

// ── HTTP request logging (Render / local stdout) ────────────────────────────
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(
  morgan(morganFormat, {
    skip: (req) => req.url === '/health' || req.url === '/favicon.ico',
  })
);

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  skip: (req) => {
    const url = typeof req.originalUrl === 'string' ? req.originalUrl : '';
    return (
      url.startsWith('/api/newsletter') ||
      url.startsWith('/api/contact') ||
      url.startsWith('/api/chat')
    );
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Stricter limit for auth endpoints
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
});

const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many subscription attempts. Please try again later.' },
});

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many contact form submissions. Please try again later.' },
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many chat requests. Please try again later.' },
});

app.use(limiter);

// ── Body Parsing ──────────────────────────────────────────────────────────────
// Cal.com webhook: raw body required for x-cal-signature-256 HMAC (see Cal.com webhook docs)
app.post(
  '/api/consultations/cal-webhook',
  raw({ type: 'application/json' }),
  (req, res, next) => {
    Promise.resolve(calWebhook(req, res)).catch(next);
  }
);


// Flutterwave webhook — auth via static `verif-hash` header from FLW dashboard.
// Raw body kept for parity (and forward-compat if we ever HMAC the body).
app.post(
  '/api/payments/flutterwave-webhook',
  raw({ type: 'application/json' }),
  (req, res, next) => {
    Promise.resolve(flutterwaveWebhook(req, res)).catch(next);
  }
);

// Optional: external cron (e.g. Render) — Bearer CRON_SECRET
app.post('/api/internal/cron/consultation-payment-expiry', async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  try {
    const processed = await processExpiredConsultationPayments();
    return res.json({ success: true, processed });
  } catch (e) {
    next(e);
  }
});

app.post('/api/internal/cron/camp-registration-expiry', async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  try {
    const processed = await processExpiredCampRegistrations();
    return res.json({ success: true, processed });
  } catch (e) {
    next(e);
  }
});

app.post('/api/internal/cron/camp-status', async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  try {
    const processed = await processCampStatusTransitions();
    return res.json({ success: true, processed });
  } catch (e) {
    next(e);
  }
});

app.post('/api/internal/cron/fx-sync', async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  try {
    const outcomes = await runFxSync();
    return res.json({ success: true, data: outcomes });
  } catch (e) {
    next(e);
  }
});

app.post('/api/internal/cron/chat-reindex', (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  Promise.resolve(cronReindexChatKnowledge(req, res, next)).catch(next);
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Resolves X-Req-Currency for every downstream handler; falls back to GBP.
app.use(resolveCurrency);

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, message: 'Well-Being API is running.', timestamp: new Date() });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/camps', campRoutes);
app.use('/api/testimonials', testimonialRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/newsletter', newsletterLimiter, newsletterRoutes);
app.use('/api/contact', contactLimiter, contactRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/tags', tagRoutes);
// Join has its own tighter limiter inside the router (it sends mail).
app.use('/api/communities', communityRoutes);
app.use('/api/chat', chatLimiter, chatRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/admin', adminRouter);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ── Global Error Handler (must be last) ──────────────────────────────────────
app.use(errorHandler);

export default app;
