import 'dotenv/config';
import app from './app';
import prisma from './config/prisma';
import { processExpiredConsultationPayments } from './services/consultationExpiry.service';
import { processExpiredCampRegistrations } from './services/campRegistrationExpiry.service';
import { processCampStatusTransitions } from './services/campStatus.service';
import { runFxSync } from './services/fx/fxSync.job';
import { FX_SYNC_INTERVAL_MS } from './config/money.config';

const PORT = process.env.PORT || 5000;

const CONSULTATION_EXPIRY_INTERVAL_MS = 60 * 1000;
const CAMP_REGISTRATION_EXPIRY_INTERVAL_MS = 60 * 1000;
const CAMP_STATUS_INTERVAL_MS = 60 * 1000;

const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('✅ Database connected.');

    setInterval(() => {
      processExpiredConsultationPayments().catch((err) =>
        console.error('[consultation-expiry]', err)
      );
    }, CONSULTATION_EXPIRY_INTERVAL_MS);

    setInterval(() => {
      processExpiredCampRegistrations().catch((err) =>
        console.error('[camp-registration-expiry]', err)
      );
    }, CAMP_REGISTRATION_EXPIRY_INTERVAL_MS);

    setInterval(() => {
      processCampStatusTransitions().catch((err) => console.error('[camp-status]', err));
    }, CAMP_STATUS_INTERVAL_MS);

    runFxSync().catch((err) => console.error('[fx-sync]', err));
    setInterval(() => {
      runFxSync().catch((err) => console.error('[fx-sync]', err));
    }, FX_SYNC_INTERVAL_MS);

    app.listen(Number(PORT), '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
      console.log(`📖 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

startServer();
