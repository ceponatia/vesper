ALTER TABLE "item_instances" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lore_chunks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "participant_relationships" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_participants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "turn_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "turns" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_cast" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worlds" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item_instances" CASCADE;--> statement-breakpoint
DROP TABLE "lore_chunks" CASCADE;--> statement-breakpoint
DROP TABLE "participant_relationships" CASCADE;--> statement-breakpoint
DROP TABLE "session_links" CASCADE;--> statement-breakpoint
DROP TABLE "session_locations" CASCADE;--> statement-breakpoint
DROP TABLE "session_participants" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
DROP TABLE "turn_messages" CASCADE;--> statement-breakpoint
DROP TABLE "turns" CASCADE;--> statement-breakpoint
DROP TABLE "world_cast" CASCADE;--> statement-breakpoint
DROP TABLE "world_items" CASCADE;--> statement-breakpoint
DROP TABLE "world_links" CASCADE;--> statement-breakpoint
DROP TABLE "world_locations" CASCADE;--> statement-breakpoint
DROP TABLE "worlds" CASCADE;--> statement-breakpoint
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_scope_exactly_one";--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_scope_exactly_one";--> statement-breakpoint
ALTER TABLE "episodes" DROP CONSTRAINT IF EXISTS "episodes_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "images" DROP CONSTRAINT IF EXISTS "images_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_session_id_sessions_id_fk";
--> statement-breakpoint
DROP INDEX "episodes_session_idx";--> statement-breakpoint
DROP INDEX "events_session_idx";--> statement-breakpoint
DROP INDEX "facts_session_status_idx";--> statement-breakpoint
DROP INDEX "images_session_idx";--> statement-breakpoint
DROP INDEX "jobs_session_idx";--> statement-breakpoint
ALTER TABLE "episodes" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "facts" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "images" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "session_id";