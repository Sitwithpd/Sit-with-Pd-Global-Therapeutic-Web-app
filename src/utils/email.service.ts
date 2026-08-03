import { sendMail } from '../config/mailer';

/** Matches `platform_settings.platformName` default; override with `EMAIL_FROM_NAME`. */
const DEFAULT_EMAIL_BRAND = 'Sit With PD';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getEmailBrandName(): string {
  const name = process.env.EMAIL_FROM_NAME?.trim();
  return name && name.length > 0 ? name : DEFAULT_EMAIL_BRAND;
}

function transactionalFrom(): string {
  const addr = process.env.EMAIL_FROM?.trim() ?? '';
  return `"${getEmailBrandName()}" <${addr}>`;
}

function emailBrandSignOff(): string {
  const brand = escapeHtml(getEmailBrandName());
  return `<p style="margin-top:24px;color:#888;font-size:12px;">— ${brand}</p>`;
}

// ── Program Purchase Confirmation ─────────────────────────────────────────────
export const sendProgramPurchaseEmail = async (
  email: string,
  name: string,
  programTitle: string
) => {
  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: `You're enrolled in "${programTitle}"!`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Hi ${name}, welcome to the program! 🎉</h2>
        <p>You have successfully purchased <strong>${programTitle}</strong>.</p>
        <p>Head to your dashboard to start learning right away.</p>
        <a href="${process.env.CLIENT_URL}/dashboard/programs" 
           style="background:#2a7c6f;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          Access Program
        </a>
        <p style="margin-top:32px;color:#888;font-size:12px;">
          If you have any questions, reply to this email.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Camp Registration Confirmation ───────────────────────────────────────────
export const sendCampRegistrationEmail = async (
  email: string,
  name: string,
  campTitle: string,
  campDate: Date
) => {
  const formattedDate = campDate.toDateString();
  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: `Camp Registration Confirmed – ${campTitle}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You're registered, ${name}! ⛺</h2>
        <p>Your spot at <strong>${campTitle}</strong> is confirmed.</p>
        <p><strong>Start Date:</strong> ${formattedDate}</p>
        <p>View your registration details in your dashboard.</p>
        <a href="${process.env.CLIENT_URL}/dashboard/bookings" 
           style="background:#2a7c6f;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          View Booking
        </a>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Consultation: payment link after Cal.com booking (PENDING_PAYMENT) ───────
export const sendConsultationPaymentLinkEmail = async (
  email: string,
  name: string,
  serviceTitle: string,
  paymentUrl: string,
  expiresInSeconds: number
) => {
  const minutes = Math.round(expiresInSeconds / 60);
  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: `Complete payment for your consultation – ${serviceTitle}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Hi ${name},</h2>
        <p>Your session time is held. Please complete payment within <strong>${minutes} minutes</strong> to confirm.</p>
        <p>If payment is not received in time, your Cal.com booking will be cancelled automatically.</p>
        <a href="${paymentUrl}" 
           style="background:#2a7c6f;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          Pay now
        </a>
        <p style="margin-top:24px;color:#888;font-size:12px;">
          This link is sent for your consultation booking. If you did not book a session, ignore this email.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Consultation Booking Confirmation ────────────────────────────────────────
export const sendConsultationBookingEmail = async (
  email: string,
  name: string,
  serviceTitle: string,
  preferredDate?: Date
) => {
  const dateText = preferredDate
    ? `<p><strong>Requested Date:</strong> ${preferredDate.toDateString()}</p>`
    : `<p>We will reach out to confirm your session time.</p>`;

  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: `Consultation Booking Received – ${serviceTitle}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Booking received, ${name}! 📅</h2>
        <p>Your booking for <strong>${serviceTitle}</strong> has been received.</p>
        ${dateText}
        <p>We'll send you a confirmation once the session is scheduled.</p>
        <a href="${process.env.CLIENT_URL}/dashboard/bookings" 
           style="background:#2a7c6f;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          View Booking
        </a>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Email Verification ────────────────────────────────────────────────────────
export const sendEmailVerificationEmail = async (
  email: string,
  name: string,
  verificationToken: string
) => {
  const verifyUrl = `${process.env.CLIENT_URL}/verify-email?token=${verificationToken}`;
  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: 'Verify your email address',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Confirm your email</h2>
        <p>Hi ${name}, thanks for signing up. Please verify your email address by clicking the button below.</p>
        <p>This link expires in <strong>48 hours</strong>.</p>
        <a href="${verifyUrl}" 
           style="background:#2a7c6f;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          Verify email
        </a>
        <p style="margin-top:24px;color:#888;font-size:12px;">
          If you didn't create an account, you can ignore this email.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Password Reset Email ──────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (
  email: string,
  name: string,
  resetToken: string
) => {
  const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;
  await sendMail({
    from: transactionalFrom(),
    to: email,
    subject: 'Reset Your Password',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>Hi ${name}, we received a request to reset your password.</p>
        <p>Click the button below. This link expires in <strong>15 minutes</strong>.</p>
        <a href="${resetUrl}" 
           style="background:#c0392b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          Reset Password
        </a>
        <p style="margin-top:24px;color:#888;font-size:12px;">
          If you didn't request this, you can safely ignore this email.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

/** Logged-in user → platform support (admin Settings `supportEmail`). */
export const sendDashboardSupportRequestEmail = async (params: {
  to: string;
  userEmail: string;
  userName: string;
  subjectLine: string;
  message: string;
}) => {
  const { to, userEmail, userName, subjectLine, message } = params;
  const safe = escapeHtml(message);
  await sendMail({
    from: transactionalFrom(),
    to,
    replyTo: userEmail,
    subject: subjectLine,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p><strong>Support request</strong> from the learner dashboard.</p>
        <p><strong>Name:</strong> ${escapeHtml(userName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(userEmail)}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
        <div style="white-space:pre-wrap;">${safe}</div>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

/** Public Contact Us form → platform support inbox. */
export const sendContactFormEmail = async (params: {
  to: string;
  fullName: string;
  email: string;
  phone: string | null;
  message: string;
  submissionId: string;
}) => {
  const { to, fullName, email, phone, message, submissionId } = params;
  const safeMessage = escapeHtml(message);
  const phoneLine = phone
    ? `<p><strong>Phone:</strong> ${escapeHtml(phone)}</p>`
    : '<p><strong>Phone:</strong> <em>Not provided</em></p>';

  await sendMail({
    from: transactionalFrom(),
    to,
    replyTo: email,
    subject: `Contact form: ${fullName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p><strong>New message</strong> from the website Contact Us form.</p>
        <p><strong>Submission ID:</strong> ${escapeHtml(submissionId)}</p>
        <p><strong>Name:</strong> ${escapeHtml(fullName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        ${phoneLine}
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
        <div style="white-space:pre-wrap;">${safeMessage}</div>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

/** Optional acknowledgement to the visitor after Contact Us submit. */
export const sendContactFormAutoReplyEmail = async (params: {
  to: string;
  fullName: string;
}) => {
  const { to, fullName } = params;
  const brand = escapeHtml(getEmailBrandName());
  await sendMail({
    from: transactionalFrom(),
    to,
    subject: `We received your message — ${getEmailBrandName()}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Hi ${escapeHtml(fullName)},</h2>
        <p>Thank you for contacting ${brand}. We've received your message and will respond as soon as we can.</p>
        <p style="margin-top:24px;color:#888;font-size:12px;">
          This is an automated confirmation — please do not reply to this email unless you need to add more detail.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Community: WhatsApp invite after a join application ──────────────────────
// Sent immediately on successful submit. This is the ONLY place the group link
// leaves the server — it is stripped from every public API response and is
// never indexed into the chat knowledge base.
export const sendCommunityWelcomeEmail = async (params: {
  to: string;
  fullName: string;
  communityTitle: string;
  whatsappLink: string;
}) => {
  const { to, fullName, communityTitle, whatsappLink } = params;
  const safeTitle = escapeHtml(communityTitle);
  // Used both as an href and as visible text, so escape for the attribute too.
  const safeLink = escapeHtml(whatsappLink);

  await sendMail({
    from: transactionalFrom(),
    to,
    subject: `You're in — ${communityTitle}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome, ${escapeHtml(fullName)}! 🎉</h2>
        <p>Your application to join <strong>${safeTitle}</strong> has been received, and your invite is ready.</p>
        <p>Tap below to join the WhatsApp group:</p>
        <a href="${safeLink}"
           style="background:#567F57;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px;">
          Join ${safeTitle}
        </a>
        <p style="margin-top:24px;font-size:13px;color:#666;">
          If the button doesn't work, copy this link into your browser:<br />
          <span style="word-break:break-all;">${safeLink}</span>
        </p>
        <p style="margin-top:24px;color:#888;font-size:12px;">
          This invite was sent to you because someone used this address to apply. If that wasn't you, you can ignore this email.
        </p>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

/** Admin notification that a new community join application arrived. */
export const sendCommunityJoinNotificationEmail = async (params: {
  to: string;
  fullName: string;
  email: string;
  phone: string | null;
  reason: string | null;
  communityTitle: string;
  requestId: string;
}) => {
  const { to, fullName, email, phone, reason, communityTitle, requestId } = params;
  const phoneLine = phone
    ? `<p><strong>Phone:</strong> ${escapeHtml(phone)}</p>`
    : '<p><strong>Phone:</strong> <em>Not provided</em></p>';
  const reasonBlock = reason
    ? `<hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
       <p><strong>Why they want to join</strong></p>
       <div style="white-space:pre-wrap;">${escapeHtml(reason)}</div>`
    : '';

  await sendMail({
    from: transactionalFrom(),
    to,
    replyTo: email,
    subject: `Community application: ${communityTitle}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p><strong>New application</strong> for <strong>${escapeHtml(communityTitle)}</strong>.</p>
        <p><strong>Request ID:</strong> ${escapeHtml(requestId)}</p>
        <p><strong>Name:</strong> ${escapeHtml(fullName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        ${phoneLine}
        ${reasonBlock}
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

/** Purchased-program participant → facilitator email on Program. */
export const sendDashboardFacilitatorMessageEmail = async (params: {
  to: string;
  userEmail: string;
  userName: string;
  programTitle: string;
  facilitatorName: string | null;
  subjectLine: string;
  message: string;
}) => {
  const { to, userEmail, userName, programTitle, facilitatorName, subjectLine, message } = params;
  const safe = escapeHtml(message);
  const fn = facilitatorName ? escapeHtml(facilitatorName) : 'Facilitator';
  await sendMail({
    from: transactionalFrom(),
    to,
    replyTo: userEmail,
    subject: subjectLine,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p>Hello ${fn},</p>
        <p>A participant in <strong>${escapeHtml(programTitle)}</strong> sent you a message via the learner dashboard.</p>
        <p><strong>From:</strong> ${escapeHtml(userName)} &lt;${escapeHtml(userEmail)}&gt;</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
        <div style="white-space:pre-wrap;">${safe}</div>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};

// ── Ops: FX sync failure ──────────────────────────────────────────────────────
export const sendFxSyncFailureEmail = async (params: {
  to: string;
  consecutiveFailures: number;
  failures: Array<{ currency: string; error: string }>;
}) => {
  const { to, consecutiveFailures, failures } = params;
  const rows = failures
    .map(
      (f) =>
        `<li><strong>${escapeHtml(f.currency)}</strong>: ${escapeHtml(f.error.slice(0, 300))}</li>`
    )
    .join('');

  await sendMail({
    from: transactionalFrom(),
    to,
    subject: `FX rate sync failing (${consecutiveFailures} consecutive runs)`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <p><strong>Exchange rate sync has failed ${consecutiveFailures} times in a row.</strong></p>
        <p>Once rates pass the staleness threshold, checkout in non-base currencies
        will be blocked. Base-currency checkout continues to work.</p>
        <ul>${rows}</ul>
        ${emailBrandSignOff()}
      </div>
    `,
  });
};
