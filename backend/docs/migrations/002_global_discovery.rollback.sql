-- ROLLBACK for backend/src/db/migrations/002_global_discovery.sql
--
-- This file is intentionally stored OUTSIDE src/db/migrations/. Every *.sql file in that directory is
-- applied automatically (in filename order) by `npm run db:migrate`, which the Render build command runs
-- on every deploy. A rollback script placed there would be applied as if it were a forward migration.
--
-- When to use: only to undo Global Food Discovery v1 after it has been applied. It removes the discovery
-- directory only. It does not touch users, restaurants, menus, carts, orders, reviews, or audit logs, so
-- the existing ordering application is unaffected either way.
--
-- Data loss: this DROPs discovery_places and its menus, i.e. every imported or owner-submitted discovery
-- listing. Take a dump first if any of that data is valuable:
--   pg_dump "$DATABASE_URL" -t discovery_places -t discovery_menu_sections -t discovery_menu_items \
--     --data-only --column-inserts > discovery_backup.sql
--
-- Run manually, never from the migrations directory:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/docs/migrations/002_global_discovery.rollback.sql
--
-- After running it you must also delete the `schema_migrations` row, or the next `npm run db:migrate`
-- will refuse to re-apply an edited 002 file (checksum mismatch) / will skip it entirely:
--   DELETE FROM schema_migrations WHERE name = '002_global_discovery.sql';

BEGIN;

-- Order matters: children first, then the parent. Triggers and their functions go with their tables,
-- but the functions are schema-level objects and must be dropped explicitly.
DROP TABLE IF EXISTS discovery_menu_items;
DROP TABLE IF EXISTS discovery_menu_sections;
DROP TABLE IF EXISTS discovery_places;

DROP FUNCTION IF EXISTS discovery_menu_items_search_vector_sync();
DROP FUNCTION IF EXISTS discovery_places_search_vector_sync();

DELETE FROM schema_migrations WHERE name = '002_global_discovery.sql';

COMMIT;

-- Verify:
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_name LIKE 'discovery\_%';   -- expected: 0
--   SELECT count(*) FROM restaurants;        -- expected: unchanged
