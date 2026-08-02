# Well-Being Platform — Backend API

Built with Node.js · TypeScript · Express · PostgreSQL · Prisma

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up the database
```bash
# Make sure PostgreSQL is running, then:
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# Seed with admin account + sample data
npm run db:seed
```

### 4. Run the server
```bash
npm run dev
```

Server runs at: `http://localhost:5000`
Health check: `http://localhost:5000/health`

---

## API Endpoints

### Auth — `/api/auth`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | Public | Create account |
| POST | `/login` | Public | Login |
| GET | `/me` | User | Get current user |
| POST | `/forgot-password` | Public | Request password reset |
| POST | `/reset-password` | Public | Reset with token |

### Programs — `/api/programs`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | List all programs (incl. `audience`, `tags`) |
| GET | `/:id` | Public | Program detail (incl. `audience`, `tags`) |
| POST | `/` | Admin | Create program — accepts `audience` (bullets) and `tags` (names) |
| PATCH | `/:id` | Admin | Update program — omit a field to keep it, send `[]` to clear |
| DELETE | `/:id` | Admin | Delete program |
| POST | `/:id/lessons` | Admin | Add lesson |
| PATCH | `/:id/lessons/:lessonId` | Admin | Update lesson |
| DELETE | `/:id/lessons/:lessonId` | Admin | Delete lesson |

### Camps — `/api/camps`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | List upcoming camps (`tiers` hold pricing; responses omit camp-level `price`; `seatsTaken` / `seatsRemaining` count **confirmed + active payment holds** only) |
| GET | `/current` | Public | Next upcoming camp (same shape) |
| GET | `/:id` | Public | Camp detail |
| POST | `/:id/register` | User | Apply for camp (`tierId` required); creates `PENDING_PAYMENT` + `paymentExpiresAt` (~60 min) or resets an expired row — see **Camp registration lifecycle** below |
| GET | `/:id/my-registration` | User | Current user's registration for this camp (`status`, `paymentExpiresAt`, tier, payment) or `null` |
| POST | `/` | Admin | Create camp (pricing via **Create tier** only); **`category` is required** |
| PATCH | `/:id` | Admin | Update camp (pricing via tier endpoints); `category` must be non-empty when present |
| DELETE | `/:id` | Admin | Delete camp |
| GET | `/:id/participants` | Admin | Paginated registrants — **all** lifecycle statuses by default; optional `?status=` filter |

#### Camp registration lifecycle
- At most **one** `CampRegistration` row per user per camp.
- **Register:** `POST /api/camps/:id/register` sets `status` to `PENDING_PAYMENT` and `paymentExpiresAt` (checkout window). Capacity / tier caps count **confirmed** registrations plus **unexpired** `PENDING_PAYMENT` holds.
- **Pay:** `POST /api/payments/initialize` with `type: "CAMP"` and `itemId` = registration id **only while** the registration is still payable (within the window). Successful Paystack `charge.success` promotes the row to `CONFIRMED` when the charge timestamp falls inside that window; otherwise the payment is flagged for **manual refund** and the seat is **not** confirmed.
- **Expiry:** A background job (`processExpiredCampRegistrations`, every minute from `server.ts`) plus optional **`POST /api/internal/cron/camp-registration-expiry`** (Bearer `CRON_SECRET`) mark overdue holds `EXPIRED`, detach stale pending payments, and free inventory. The user may **register again** — the **same** row is reused and reset to `PENDING_PAYMENT` with a new deadline.

### Consultations — `/api/consultations`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/services` | Public | List services (incl. `coverImageUrl`, `audience`, `whatsIncluded`, `format`, `tags`) |
| GET | `/services/:id` | Public | Service detail (same shape) |
| POST | `/book` | User | Book consultation |
| GET | `/my` | User | My bookings |
| GET | `/` | Admin | All bookings |
| PATCH | `/:id` | Admin | Update booking |
| POST | `/services` | Admin | Create service — **`multipart/form-data`**, optional `coverImage` file |
| PATCH | `/services/:id` | Admin | Update service — same; JSON callers may pass `coverImageUrl` as a string |

### Tags — `/api/tags`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | Shared tag vocabulary; optional `?type=TOPIC\|FORMAT` and `?search=` |

Tags are **created on demand**. Passing a name that doesn't exist yet on a
program / consultation / community create or update adds it to the vocabulary
rather than erroring — there is no separate "create tag" endpoint. Tags are
deduped by a normalised slug scoped to their type, so `Wellness` can exist as
both a `TOPIC` and a `FORMAT` without colliding.

Two shapes, deliberately distinct:
- **`tags`** (`TOPIC`) — short reusable pills, many per entity, shared vocabulary.
- **`audience` / `whatsIncluded` / `gains`** — full-sentence bullets written per
  entity. Plain `String[]` columns, not tags, and never shared.
- **`format`** (`FORMAT`) — exactly one per consultation service, via FK.

### Communities — `/api/communities`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | Published communities — **`whatsappLink` is stripped** |
| GET | `/:idOrSlug` | Public | Community detail by cuid or slug — link stripped |
| POST | `/:idOrSlug/join` | Public | Apply to join; saves the request and **emails the group link immediately**. Rate limited to 10 / 15 min, honeypot `website` field |
| GET | `/admin/all` | Admin | Paginated list **including** `whatsappLink` |
| GET | `/admin/:id` | Admin | Detail including `whatsappLink` |
| POST | `/` | Admin | Create community |
| PATCH | `/:id` | Admin | Update community |
| DELETE | `/:id` | Admin | Delete (cascades tags + join requests) |
| GET | `/admin/join-requests` | Admin | Paginated applications; `?communityId=`, `?search=` |
| POST | `/admin/join-requests/:id/resend` | Admin | Retry a failed invite delivery |

#### Community join lifecycle
- Joining is **anonymous** — no account required. `agreedToPolicy` must be true.
- One row per `(communityId, email)`. Re-applying **updates** the existing row
  instead of sending the invite again.
- The invite send is best-effort: the application is always saved and the
  endpoint always returns 201. `linkEmailedAt` is set on success; on failure it
  stays null, `emailError` records why, and the response carries
  `data.emailed: false` so the UI can say "we'll send it shortly" rather than
  promising an inbox. Admins retry via the resend endpoint.

> **`whatsappLink` is a secret.** It is the entire value of a membership —
> anyone holding it can join without applying. It is stripped from every public
> response by `toPublicCommunity()` and is deliberately **excluded from the chat
> knowledge index** (see `community.extractor.ts`), because retrieved RAG chunks
> are pasted into the model prompt and would be handed to any visitor who asked.

### Payments — `/api/payments`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/initialize` | User | Start Paystack (`PROGRAM` / `CAMP` / `CONSULTATION`). For **`CAMP`**, `itemId` is the registration id and checkout is rejected once the hold expired or the application is already confirmed — see Camps lifecycle above |
| GET | `/verify/:reference` | Public | Check payment status |
| POST | `/webhook` | Paystack | Webhook handler |
| GET | `/` | Admin | All payment records |

### Dashboard — `/api/dashboard`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | User | Full dashboard data (`campRegistrations` expose `status`, `paymentExpiresAt`, and payment timestamps for “complete payment” UX) |
| GET | `/programs/:programId` | User | Access program content |

### Admin — `/api/admin`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/stats` | Admin | Platform stats |
| GET | `/users` | Admin | All users |
| GET | `/users/:id` | Admin | User detail |
| POST | `/chat/reindex` | Admin | Rebuild AI chat knowledge index (optional `?sourceType=PROGRAM`) |
| GET | `/chat/stats` | Admin | Chat chunk counts + usage summary |

### Chat — `/api/chat`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/config` | Public | Widget intro, disclaimers, suggested prompts |
| POST | `/sessions` | Public (+ optional JWT) | Create session; sets httpOnly cookies |
| GET | `/sessions/:sessionId` | Session cookies | Message history |
| POST | `/sessions/:sessionId/messages` | Session cookies | User message → AI reply (JSON or SSE with `"stream": true`) |

**First deploy:** run `npm run chat:reindex` (or `POST /api/admin/chat/reindex`) after setting `OPENAI_API_KEY` so RAG has indexed content.

---

## Payment Flow

Camp applications follow the same Paystack steps with an extra gate: **`POST /api/payments/initialize`** for `type: "CAMP"` only succeeds while the registration's **`paymentExpiresAt`** is still in the future (`PENDING_PAYMENT`). After Paystack succeeds, the webhook sets the registration to **`CONFIRMED`** when the charge time is within that window.

```
1. User clicks "Buy" / "Register" / "Book"
2. POST /api/payments/initialize  → returns Paystack authorization_url
3. Frontend redirects user to Paystack checkout page
4. User pays on Paystack
5. Paystack calls POST /api/payments/webhook (server-to-server)
6. Webhook verifies signature, fulfills purchase, sends confirmation email
7. Frontend calls GET /api/payments/verify/:reference to show result
```

---

## Seeded Admin Credentials
```
Email:    admin@wellbeing.com
Password: Admin@1234
```
Change these immediately in production.

---

## Local database replica (Docker)

Migrations require the **pgvector** extension, so a stock `postgres` image will
fail on `CREATE EXTENSION vector`. Use the pgvector image:

```bash
docker run -d --name swpd-db -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=swpd \
  -p 55432:5432 pgvector/pgvector:pg17

DATABASE_URL="postgresql://postgres:dev@localhost:55432/swpd" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:dev@localhost:55432/swpd" npm run db:seed
```

Pass `DATABASE_URL` inline (or via a separate env file) so the real `.env` is
never pointed at the throwaway database by accident.

---

## Folder Structure
```
src/
├── config/          # Prisma, Cloudinary, OpenAI/chat config
├── controllers/     # Route handler logic
├── data/            # Static chat platform knowledge (RAG policy doc)
├── lib/             # Serializers (tags, community, camp), pagination, gateways
├── middleware/      # Auth, error handling, file uploads
├── routes/          # Express route definitions
├── services/        # Tags, communities, camp inventory, platform settings
├── services/chat/   # RAG indexing, orchestration, safety
├── utils/           # Email service
├── types/           # TypeScript types
├── app.ts           # Express app
└── server.ts        # Entry point

prisma/
├── schema.prisma    # Database schema
└── seed.ts          # Seed data
```
