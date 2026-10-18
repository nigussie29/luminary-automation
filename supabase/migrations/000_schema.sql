-- Luminary Automation keeps all of its tables in its own `automation` schema, so it can share a
-- Supabase project with Luminary Academy (whose tables live in `public`) without any overlap.
-- Every database connection sets: search_path = automation, public (see server/db/index.js).
create schema if not exists automation;
set search_path to automation, public;
