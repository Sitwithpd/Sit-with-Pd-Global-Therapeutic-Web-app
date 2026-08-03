-- A user may now hold several registrations for one camp. The guard moves to
-- "no active hold and no pending payment", enforced in the register transaction.
DROP INDEX "camp_registrations_userId_campId_key";
CREATE INDEX "camp_registrations_userId_campId_idx" ON "camp_registrations"("userId", "campId");

CREATE TABLE "camp_participants" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "age" INTEGER,
    "relationship" TEXT,
    "dietaryRequirements" TEXT,
    "medicalConditions" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camp_participants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "camp_participants_registrationId_order_idx" ON "camp_participants"("registrationId", "order");

ALTER TABLE "camp_participants" ADD CONSTRAINT "camp_participants_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "camp_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the manifest from the existing applicantDetails JSON so pre-existing
-- bookings are not left with an empty roster.
INSERT INTO "camp_participants" ("id", "registrationId", "fullName", "isLead", "order", "dietaryRequirements", "medicalConditions", "emergencyContactName", "emergencyContactPhone", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  r.id,
  COALESCE(NULLIF(TRIM(r."applicantDetails"->>'fullName'), ''), TRIM(u."firstName" || ' ' || u."lastName"), 'Unnamed attendee'),
  true,
  0,
  NULLIF(TRIM(r."applicantDetails"->>'dietaryRestrictions'), ''),
  NULLIF(TRIM(r."applicantDetails"->>'medicalConditions'), ''),
  NULLIF(TRIM(r."applicantDetails"->'emergencyContact'->>'name'), ''),
  NULLIF(TRIM(r."applicantDetails"->'emergencyContact'->>'phone'), ''),
  NOW(),
  NOW()
FROM "camp_registrations" r
JOIN "users" u ON u.id = r."userId";

INSERT INTO "camp_participants" ("id", "registrationId", "fullName", "isLead", "age", "relationship", "order", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  r.id,
  COALESCE(NULLIF(TRIM(member->>'fullName'), ''), 'Unnamed attendee'),
  false,
  CASE WHEN member->>'age' ~ '^\d+$' THEN (member->>'age')::int ELSE NULL END,
  NULLIF(TRIM(member->>'relationship'), ''),
  idx::int,
  NOW(),
  NOW()
FROM "camp_registrations" r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(r."applicantDetails"->'partyMembers') = 'array'
      THEN r."applicantDetails"->'partyMembers'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS m(member, idx);
