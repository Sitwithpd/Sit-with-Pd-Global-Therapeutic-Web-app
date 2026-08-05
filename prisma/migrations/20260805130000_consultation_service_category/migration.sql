-- Single free-text phrase, mirroring Camp.category.
--
-- Nullable so existing services migrate untouched: the API requires it on
-- create, and an admin editing an older service supplies it then. No index —
-- the filter is case-insensitive, which a plain btree would not serve, and the
-- table holds a handful of rows.

ALTER TABLE "consultation_services" ADD COLUMN IF NOT EXISTS "category" TEXT;
