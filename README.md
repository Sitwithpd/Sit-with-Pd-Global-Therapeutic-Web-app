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
| GET | `/` | Public | List all programs (incl. `audience`, `tags`, `videoLinks`) |
| GET | `/:id` | Public | Program detail (incl. `audience`, `tags`, `videoLinks`) |
| POST | `/` | Admin | Create program — accepts `audience` (bullets), `tags` (names) and `videoLinks` |
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
| GET | `/:id/my-registrations` | User | **All** of the user's units for this camp, plus `actionable`, `confirmedUnits`, `confirmedSeats`, `canBookAnother`, `blockedReason`. `/my-registration` is kept as an alias |
| POST | `/` | Admin | Create camp (pricing via **Create tier** only); **`category` is required** |
| PATCH | `/:id` | Admin | Update camp (pricing via tier endpoints); `category` must be non-empty when present |
| DELETE | `/:id` | Admin | Delete camp |
| GET | `/:id/participants` | Admin | Paginated registrants — **all** lifecycle statuses by default; optional `?status=` filter |

#### Seats, units and tiers

Three quantities in **different units** — the usual source of confusion:

| Field | Unit | Meaning |
|---|---|---|
| `Camp.capacity` | people | Total bodies the camp holds, across all tiers |
| `CampTier.seatsPerUnit` | people per purchase | One Family purchase = 5 people |
| `CampTier.maxUnits` | purchases | How many times this tier can be sold (`null` = uncapped) |
| `CampRegistration.participantCount` | people | Copied from `seatsPerUnit` when booked |

So there are two independent counters: **camp seats** (`SUM(participantCount)`
over holding rows, ≤ `capacity`) and **tier units** (`COUNT(rows)` for a tier,
< `maxUnits`).

Every camp read returns per-tier availability so the UI never offers a package
that cannot be booked:

```jsonc
{ "unitsSold": 4, "unitsRemaining": 0, "isAvailable": false,
  "unavailableReason": "TIER_SOLD_OUT" }
```

`unavailableReason` is `TIER_SOLD_OUT` (hit `maxUnits`), `INSUFFICIENT_SEATS`
(fewer seats remain than `seatsPerUnit`), `CAMP_CLOSED`, or `null`. The camp
also carries `hasBookableTier` — **a camp can show seats remaining while every
tier is unbookable**, because none of them fits in the space left.

`seatsPerUnit` cannot be changed while a tier has holding registrations:
`participantCount` is frozen per booking, so editing it would silently desync
capacity maths. Create a new tier instead.

#### Attendee manifest

`CampParticipant` is one row per attendee, including the lead. It is the roster
the organiser works from, so it is a table rather than a JSON blob — queryable,
and per-person dietary / medical / emergency fields live on it.

Registration requires a manifest naming **exactly** `seatsPerUnit` people.
Blank and duplicate names are rejected. A count alone is not enough to run a
camp.

#### Camp registration lifecycle
- A user may hold **several** registrations per camp (multiple units), but only
  **one checkout at a time**: a new booking is refused while they have an
  unexpired `PENDING_PAYMENT` hold, a `PENDING` payment, or a payment under
  review. Otherwise one account could hold unlimited inventory through repeated
  unpaid holds. `blockedReason` on `/my-registrations` says which.
- **Register:** `POST /api/camps/:id/register` takes `tierId` + `participants[]` and sets `status` to `PENDING_PAYMENT` and `paymentExpiresAt` (checkout window). Capacity / tier caps count **confirmed** registrations plus **unexpired** `PENDING_PAYMENT` holds.
- **Pay:** `POST /api/payments/initialize` with `type: "CAMP"` and `itemId` = registration id **only while** the registration is still payable (within the window). A successful Flutterwave `charge.completed` promotes the row to `CONFIRMED` when the charge timestamp falls inside that window; otherwise the payment is flagged for **manual refund** and the seat is **not** confirmed.
- **Expiry:** A background job (`processExpiredCampRegistrations`, every minute from `server.ts`) plus optional **`POST /api/internal/cron/camp-registration-expiry`** (Bearer `CRON_SECRET`) mark overdue holds `EXPIRED`, detach stale pending payments, and free inventory. The user may **register again**, which creates a **new** row — expired rows are kept as history.

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

### Video embeds (`videoLinks`)

`Program` and `Community` each carry a `videoLinks` array of YouTube URLs.
**Array order is the display order** — there is no separate order column, so a
`PATCH` replaces the whole list and that is also how the admin reorders them.
Omit the field to keep the current list; send `[]` to clear it.

Links are validated and canonicalised on write. All of these are accepted and
stored as `https://www.youtube.com/watch?v=<id>`:

```
https://youtu.be/<id>                     https://www.youtube.com/embed/<id>
https://www.youtube.com/watch?v=<id>      https://www.youtube.com/shorts/<id>
https://m.youtube.com/watch?v=<id>        https://www.youtube.com/live/<id>
```

Extra query params (`&list=`, `&t=`) are dropped. Anything that is not a
YouTube video URL is **rejected with a 400** rather than stored — a link that
cannot embed is worse than no link. Duplicates are collapsed by video id, so
the same video pasted in two different URL forms is stored once, keeping its
first position. Maximum 12 per entity.

Two shapes, deliberately distinct:
- **`tags`** (`TOPIC`) — short reusable pills, many per entity, shared vocabulary.
- **`audience` / `whatsIncluded` / `gains`** — full-sentence bullets written per
  entity. Plain `String[]` columns, not tags, and never shared.
- **`format`** (`FORMAT`) — exactly one per consultation service, via FK.

### Communities — `/api/communities`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | Published communities (incl. `videoLinks`) — **`whatsappLink` is stripped** |
| GET | `/:idOrSlug` | Public | Community detail by cuid or slug (incl. `videoLinks`) — link stripped |
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
| POST | `/initialize` | User | Start Flutterwave checkout (`PROGRAM` / `CAMP` / `CONSULTATION`) in the `X-Req-Currency` currency. For **`CAMP`**, `itemId` is the registration id and checkout is rejected once the hold expired or the application is already confirmed — see Camps lifecycle above |
| GET | `/verify/:reference` | Public | Check payment status |
| POST | `/flutterwave-webhook` | Flutterwave | Webhook handler (validates amount + currency against the locked quote) |
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

## Money, currency and FX

**GBP is the base currency.** It is a code constant (`BASE_CURRENCY` in
`src/lib/money.ts`), not an admin setting. Every price is stored once, in GBP,
as **integer minor units** (`priceMinor`, pence) — never a float. Entities no
longer carry their own `currency` column.

### Requesting a currency

Clients declare a presentment currency with the **`X-Req-Currency`** header.
Anything unrecognised or disabled silently falls back to GBP — a bad header is
a client problem, not a reason to fail a page load. Responses set
`Vary: X-Req-Currency`.

```bash
curl /api/programs                          # GBP
curl /api/programs -H 'X-Req-Currency: USD' # USD
curl /api/programs -H 'X-Req-Currency: XYZ' # GBP (fallback)
```

Price-bearing entities keep their familiar shape; the values are computed, not
stored:

```jsonc
{ "price": 114.99, "priceMinor": 11499, "currency": "USD" }
// admin routes additionally: basePriceMinor, baseCurrency, fxRateId
```

### How a price is derived

```
raw   = priceMinor × rate × (1 + margin)
final = ceil(raw → per-currency step) → optional charm ending
```

Rounding **always goes up** — rounding down would systematically undercharge
against the GBP base. Steps scale with magnitude (a £5 item stepped to the
nearest 5 doubles; a £2,000 item stepped to the nearest 1 looks unrounded), and
charm endings are off for NGN where `.99` reads as noise. There is a hard
invariant that the final price is never below `raw`.

```
£79.00  →  $114.99   /   ₦155,000
```

### Rates

Rates come from Flutterwave's `/v3/transfers/rates`, queried in the **sweep
direction** (quote → GBP) because that is the rate you actually convert back
at — pricing off it is self-hedging, whereas mid-market would leave you short
by Flutterwave's spread on every withdrawal.

`FxRate` is **append-only**. Payments reference a rate by id, so superseding
writes `supersededAt` and inserts a new row rather than updating in place.

A new row is only written when the rate moves more than
`FX_DRIFT_THRESHOLD_BPS` (default 150 = 1.5%). This threshold is what keeps
request-time conversion stable: ceiling rounding flips at step boundaries, so
without it a 0.2% wobble would change advertised prices. Putting the threshold
on ingest means prices are deterministic with no price cache anywhere.

Sync runs every `FX_SYNC_INTERVAL_MINUTES` from `server.ts`, plus
`POST /api/internal/cron/fx-sync` (Bearer `CRON_SECRET`). A failed lookup never
supersedes a good rate; after `FX_ALERT_AFTER_FAILURES` consecutive total
failures the support inbox is emailed.

### Stale rates

Past `FX_STALE_THRESHOLD_HOURS` (default 12):

- **Checkout** in a non-base currency returns **503** telling the user to try GBP.
- **GBP checkout always works** — it needs no rate. Degrade, don't outage.
- **Listings never fail**; display falls back to the base currency.

### Payment ledger

Every payment records what it was quoted at, so refunds and reporting stay
correct forever:

| Column | Meaning |
|---|---|
| `presentmentCurrency` / `presentmentAmountMinor` | what the customer was charged |
| `baseCurrency` / `baseAmountMinor` | the GBP equivalent at quote time |
| `fxRateId` / `fxRate` / `marginBps` | the exact rate used (null for GBP) |
| `quotedAt` | when the quote was locked |
| `settlementCurrency` | learned from the webhook — the card decides, not checkout |

**Refunds must use the ledger rate, never today's.** That is the entire reason
it is recorded.

Revenue is reported in GBP from `baseAmountMinor` using each row's historical
rate, so last month's figure never changes. `GET /api/admin/stats` also returns
a per-currency breakdown.

### Admin / ops endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/fx/rates` | Current rates, age, staleness, failure count |
| POST | `/api/admin/fx/sync` | Trigger a sync now |
| POST | `/api/admin/fx/rates` | Manual rate override (`source: manual`) |
| GET | `/api/admin/currencies` | Supported currency list |
| PATCH | `/api/admin/currencies/:code` | Enable/disable, set `marginBps` |

Since Flutterwave is the only provider, `SupportedCurrency` **is** the
capability list — seed only what it can both collect and settle.

---

## Payment Flow

**Flutterwave is the only provider.** Camp applications have an extra gate:
**`POST /api/payments/initialize`** for `type: "CAMP"` only succeeds while the
registration's **`paymentExpiresAt`** is still in the future
(`PENDING_PAYMENT`). The webhook promotes the registration to **`CONFIRMED`**
only when the charge time falls inside that window; the checkout session is
also bounded to the remaining hold so it cannot outlive the seat.

The presentment currency comes from the `X-Req-Currency` header, never the
request body, and the quote is locked on the payment row before redirecting.

```
1. User clicks "Buy" / "Register" / "Book"
2. POST /api/payments/initialize  → returns Flutterwave authorization_url
3. Frontend redirects user to Flutterwave checkout page
4. User pays on Flutterwave
5. Flutterwave calls POST /api/payments/flutterwave-webhook (server-to-server)
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

## Migration runbook — money / multi-currency

Three steps, deliberately not one deploy. `prisma migrate deploy` is run
manually here (the build script does not run it), so the operator controls the
gap between them.

```bash
# 1. Expand — additive, reversible. Adds FX tables + nullable priceMinor and
#    ledger columns. Old columns still present.
npx prisma migrate deploy   # stops after ..._money_expand_fx_tables

# 2. Backfill — seeds currencies, pulls live rates from Flutterwave, converts
#    every price and historical payment. Preview first.
npm run db:backfill-money -- --dry-run
npm run db:backfill-money

# 3. Contract — irreversible. Only after step 2 reports zero unconverted rows.
npx prisma migrate deploy   # applies ..._money_contract_drop_legacy_currency
```

Leave at least one deploy between 2 and 3: until the contract step runs, the
old `price` / `currency` columns still hold the original values, so a bad
backfill is recoverable.

Two things to know about the backfill:

- **Migration-day rates permanently set the GBP catalogue.** A ₦50,000 programme
  becomes whatever that day's rate makes it. Eyeball the converted prices in
  the gap before step 3.
- **Pre-migration revenue in GBP is an estimate.** Historical payments are
  converted at today's rate because no historical rates exist; those rows point
  at an `FxRate` marked `source: "migration"` so reporting can flag them.

Before removing the Paystack webhook (step 3), confirm nothing is in flight:

```sql
SELECT count(*) FROM payments WHERE provider = 'PAYSTACK' AND status = 'PENDING';
```

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
