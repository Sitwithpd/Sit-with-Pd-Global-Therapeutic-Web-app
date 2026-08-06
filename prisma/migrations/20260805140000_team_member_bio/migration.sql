-- Long-form profile copy for a team member.
--
-- Nullable: existing members predate the field and the API treats it as
-- optional, so there is nothing to backfill. TEXT rather than VARCHAR — the
-- length cap is enforced in the controller, where it can return a 400 rather
-- than surfacing as a database error.

ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "bio" TEXT;
