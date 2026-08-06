import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'samoluabereola@gmail.com';
const ADMIN_PASSWORD = 'Admin@1234';

// Prices are stored as integer minor units in the base currency (GBP pence).
// See src/lib/money.ts — never a float, and never a per-entity currency.
const GBP = (pounds: number) => BigInt(Math.round(pounds * 100));

async function main() {
  console.log('🌱 Seeding database...');

  // Create Admin user
  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      firstName: 'Sam',
      lastName: 'Admin',
      email: 'samoluabereola@gmail.com',
      password: hashedPassword,
      role: Role.ADMIN,
      isEmailVerified: true,
    },
  });

  console.log(`✅ Admin created: ${admin.email}`);

  // Create a sample consultation service
  await prisma.consultationService.upsert({
    where: { id: 'seed-service-1' },
    update: {},
    create: {
      id: 'seed-service-1',
      title: 'Personal Wellness Consultation',
      description: 'A 60-minute one-on-one session focused on your personal wellness journey.',
      category: 'Personal Wellness',
      priceMinor: GBP(150),
      duration: 60,
    },
  });

  // Create a sample program
  await prisma.program.upsert({
    where: { id: 'seed-program-1' },
    update: {
      description: 'Transform your mental wellness with this structured 30-day program. Through guided sessions and reflective practice, you build habits that support presence and resilience.',
      category: 'LEADERS',
      durationWeeks: 4,
      hoursPerWeek: 2,
      certificateLabel: 'Digital certificate',
      learningOutcomes: {
        set: [
          'Greater emotional awareness and self-understanding',
          'Practical tools for daily stress regulation',
          'A sustainable personal mindfulness practice',
        ],
      },
    },
    create: {
      id: 'seed-program-1',
      title: '30-Day Mindfulness Journey',
      category: 'LEADERS',
      description:
        'Transform your mental wellness with this structured 30-day program. Through guided sessions and reflective practice, you build habits that support presence and resilience.',
      priceMinor: GBP(250),
      durationWeeks: 4,
      hoursPerWeek: 2,
      certificateLabel: 'Digital certificate',
      learningOutcomes: [
        'Greater emotional awareness and self-understanding',
        'Practical tools for daily stress regulation',
        'A sustainable personal mindfulness practice',
      ],
      isPublished: true,
      weeks: {
        create: [
          {
            title: 'Week 1: Introduction to Mindfulness',
            description: 'What mindfulness is and why it matters.',
            order: 1,
            modules: {
               create: [
                 {
                    title: 'Breathing Techniques',
                    description: 'Core breathing exercises for daily practice.',
                    type: 'VIDEO',
                    contentUrl: 'https://youtube.com',
                    order: 1
                 }
               ]
            }
          }
        ],
      },
    },
  });

  console.log('✅ Sample data seeded.');
  console.log('\n🔑 Admin credentials:');
  console.log(`   Email:    ${ADMIN_EMAIL}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
