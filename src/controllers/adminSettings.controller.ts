import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { ensurePlatformSettings, PLATFORM_SETTINGS_ID } from '../services/platformSettings.service';
import { isValidIanaTimezone } from '../lib/timezone';


// GET /api/admin/settings
export const getAdminPlatformSettings = catchAsync(async (_req: Request, res: Response) => {
  const settings = await ensurePlatformSettings();
  res.json({ success: true, message: 'Settings retrieved.', data: settings });
});

// PATCH /api/admin/settings/general
export const patchAdminGeneralSettings = catchAsync(async (req: Request, res: Response) => {
  const { platformName, supportEmail, defaultTimezone } = req.body as Record<
    string,
    unknown
  >;

  const hasAny =
    platformName !== undefined || supportEmail !== undefined || defaultTimezone !== undefined;

  if (!hasAny) {
    throw new AppError('Provide at least one field: platformName, supportEmail, defaultTimezone.', 400);
  }

  const data: Prisma.PlatformSettingsUpdateInput = {};

  if (platformName !== undefined) {
    if (typeof platformName !== 'string' || !platformName.trim()) {
      throw new AppError('platformName cannot be empty.', 400);
    }
    data.platformName = platformName.trim();
  }

  if (supportEmail !== undefined) {
    if (typeof supportEmail !== 'string' || !supportEmail.trim()) {
      throw new AppError('supportEmail cannot be empty.', 400);
    }
    data.supportEmail = supportEmail.trim().toLowerCase();
  }

  if (defaultTimezone !== undefined) {
    if (typeof defaultTimezone !== 'string') throw new AppError('defaultTimezone must be a string.', 400);
    const tz = defaultTimezone.trim();
    if (!tz || !isValidIanaTimezone(tz)) throw new AppError('Invalid defaultTimezone.', 400);
    data.defaultTimezone = tz;
  }


  await ensurePlatformSettings();
  const updated = await prisma.platformSettings.update({
    where: { id: PLATFORM_SETTINGS_ID },
    data,
  });

  res.json({ success: true, message: 'General settings updated.', data: updated });
});

// PATCH /api/admin/settings/features
export const patchAdminFeaturesSettings = catchAsync(async (req: Request, res: Response) => {
  const { maintenanceMode, allowUserRegistration, requireEmailVerification, autoEnrollment } =
    req.body as Record<string, unknown>;

  const hasAny =
    maintenanceMode !== undefined ||
    allowUserRegistration !== undefined ||
    requireEmailVerification !== undefined ||
    autoEnrollment !== undefined;

  if (!hasAny) {
    throw new AppError(
      'Provide at least one field: maintenanceMode, allowUserRegistration, requireEmailVerification, autoEnrollment.',
      400
    );
  }

  const data: Prisma.PlatformSettingsUpdateInput = {};

  if (maintenanceMode !== undefined) {
    if (typeof maintenanceMode !== 'boolean') throw new AppError('maintenanceMode must be a boolean.', 400);
    data.maintenanceMode = maintenanceMode;
  }
  if (allowUserRegistration !== undefined) {
    if (typeof allowUserRegistration !== 'boolean')
      throw new AppError('allowUserRegistration must be a boolean.', 400);
    data.allowUserRegistration = allowUserRegistration;
  }
  if (requireEmailVerification !== undefined) {
    if (typeof requireEmailVerification !== 'boolean')
      throw new AppError('requireEmailVerification must be a boolean.', 400);
    data.requireEmailVerification = requireEmailVerification;
  }
  if (autoEnrollment !== undefined) {
    if (typeof autoEnrollment !== 'boolean') throw new AppError('autoEnrollment must be a boolean.', 400);
    data.autoEnrollment = autoEnrollment;
  }

  await ensurePlatformSettings();
  const updated = await prisma.platformSettings.update({
    where: { id: PLATFORM_SETTINGS_ID },
    data,
  });

  res.json({ success: true, message: 'Platform features updated.', data: updated });
});

// PATCH /api/admin/settings/notifications
export const patchAdminNotificationsSettings = catchAsync(async (req: Request, res: Response) => {
  const { emailNotificationsEnabled } = req.body as Record<string, unknown>;

  if (emailNotificationsEnabled === undefined) {
    throw new AppError('emailNotificationsEnabled is required.', 400);
  }
  if (typeof emailNotificationsEnabled !== 'boolean') {
    throw new AppError('emailNotificationsEnabled must be a boolean.', 400);
  }

  await ensurePlatformSettings();
  const updated = await prisma.platformSettings.update({
    where: { id: PLATFORM_SETTINGS_ID },
    data: { emailNotificationsEnabled },
  });

  res.json({
    success: true,
    message: 'Notification settings updated.',
    data: updated,
  });
});
