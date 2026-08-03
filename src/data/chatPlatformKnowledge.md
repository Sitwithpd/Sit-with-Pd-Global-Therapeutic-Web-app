# Sit With PD — Platform Help (for AI assistant)

This document describes how the Sit With PD website and platform work. Answers about booking, payments, and navigation should follow this content. Frontend paths below are placeholders until confirmed with the frontend team.

---

## About Sit With PD

Sit With PD is a wellbeing platform offering structured online programs, in-person or retreat-style camps, and one-to-one wellness consultations. The platform helps people build habits that support presence, resilience, and personal growth.

Sit With PD provides educational programs and wellness services. It is not a crisis service and does not replace licensed medical or mental health treatment.

**Browse offerings:** Programs at `/programs`, camps at `/camps`, consultations at `/consultations`.

---

## Creating an account and signing in

Visitors can create a free account to purchase programs, register for camps, and book consultations. Sign-in may use email and password or Google Sign-In, depending on site configuration.

You need an account before registering for a camp or completing most purchases. After signing in, your personal hub is the dashboard at `/dashboard`.

If you forgot your password, use the Forgot password flow on the login page at `/login`.

---

## Online programs — browsing and purchasing

Published programs are listed at `/programs`. Each program has a detail page at `/programs/{programId}` showing the title, description, price, duration, learning outcomes, and week-by-week structure (weeks and modules).

Program categories include options for Leaders, Students, and Professionals.

To buy a program:

1. Browse `/programs` and open a program you are interested in.
2. Sign in or create an account if prompted.
3. Start checkout and pay through the site’s payment provider (Flutterwave — see Payments below).
4. After payment succeeds, you are enrolled in that program.

Program content (videos, readings, modules) is accessed from your dashboard after purchase, not from the public marketing page alone.

---

## Accessing a program after purchase

After a successful program payment, go to `/dashboard` to see your enrolled programs and open the learning content.

From the dashboard you can work through weeks and modules, track progress, and mark modules complete. If you purchased a program but do not see it, confirm payment completed successfully and that you are signed into the same account used at checkout.

For help with access issues, use the Contact page at `/contact` or message support from the dashboard if that option is available.

---

## Wellness camps — overview

Camps are retreat-style experiences with dates, location, capacity, and tiered pricing (for example Individual, Couple, or Family packages). Upcoming camps are listed at `/camps`. Each camp has a detail page at `/camps/{campId}` with description, benefits, tiers, pricing, and gallery images.

Camp pricing is set per tier, not as a single camp-wide price. Each tier may include different inclusions (such as accommodation, meals, or guided sessions) and consumes a number of seats from camp capacity.

---

## Camp registration and payment window

To register for a camp you must be signed in. On the camp detail page, choose a tier and submit your registration.

When registration succeeds:

1. Your application status is **Pending payment**.
2. A seat is held for you for approximately **60 minutes**.
3. You must complete payment within that window or the hold expires and the seat may be released.

If your hold expires, you can usually register again for the same camp — the platform reuses your registration row and starts a new payment window.

After payment succeeds within the window, your registration is **Confirmed**. If payment completes after the window has expired, the seat may not be confirmed and support may need to assist with a refund.

View camps at `/camps`. Manage active registrations and complete payment from `/dashboard` when a payment is still pending.

---

## Consultations — booking a session

Consultation services (title, description, price, and duration) are listed at `/consultations`. Booking is typically done through **Cal.com** scheduling linked from the consultation service.

General flow:

1. Sign in to your account.
2. Go to `/consultations` and choose a service.
3. Book a time slot through the Cal.com booking flow.
4. After booking, the consultation may enter a **pending payment** state.
5. Complete payment within approximately **one hour** using the payment link (email or on-site flow, depending on configuration).

Consultations use the same payment provider as programs and camps (Flutterwave). Prices are set in GBP and shown in your selected currency at checkout.

For booking help, visit `/consultations` or `/contact`.

---

## Payments on Sit With PD

The platform uses **Flutterwave**. Prices are set in GBP (the platform's base currency) and converted to your selected currency for display and checkout. Supported currencies vary; GBP is always available.

Payment types include:

- **Program** — purchase enrollment in an online program.
- **Camp** — pay for a camp registration that is in pending payment status.
- **Consultation** — pay for a booked consultation within the payment window.

Typical checkout steps:

1. User initiates purchase, registration, or booking.
2. The site starts payment and redirects to Flutterwave checkout.
3. After paying, the provider notifies the platform and the purchase, camp registration, or consultation is updated.
4. The user can verify payment status on the site’s payment verification page after redirect.

Camp and consultation payments must usually be completed within their time limits (about 60 minutes for camps, about one hour for consultations after booking).

---

## Blog and wellbeing articles

Published blog posts cover topics such as Reflection, Wellbeing, and Personal Growth. Articles are read on the blog section of the site at paths like `/blog/{slug}`.

The blog is for general wellbeing content and does not replace professional advice.

---

## Contacting support

For questions the assistant cannot answer, account issues, payment problems, or refund requests, use the **Contact Us** form at `/contact`.

The platform also has a configured support email (shown in site settings). Logged-in users may be able to send a support message from `/dashboard` depending on the frontend.

Sit With PD support handles platform and booking questions. For urgent mental health crises, contact local emergency services or a qualified professional — do not rely on this website chat for crisis help.

---

## Dashboard — your account hub

Signed-in users use `/dashboard` to:

- Open purchased programs and continue learning
- See camp registrations, payment deadlines, and complete pending camp payments
- View consultation bookings and payment status
- Access support or facilitator contact options where available

Questions about **your** specific registration, payment, or booking status require you to be **signed in**. The public assistant can explain how things work; personal status is available in the dashboard after login.

---

## What this assistant can and cannot do

This assistant helps with general information about Sit With PD programs, camps, consultations, payments, and how to use the site.

It does **not** provide medical advice, diagnosis, or mental health treatment. It is not a substitute for therapy or crisis support.

For personal account details (for example “where is my camp payment?” or “my consultation status”), sign in and check `/dashboard` or contact support at `/contact`.
