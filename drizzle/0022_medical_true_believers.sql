ALTER TABLE "episodes" DROP CONSTRAINT "episodes_scope_exactly_one";--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_scope_exactly_one";--> statement-breakpoint
ALTER TABLE "character_chat_messages" DROP CONSTRAINT "character_chat_messages_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "character_chat_messages" DROP CONSTRAINT "character_chat_messages_character_id_characters_id_fk";
--> statement-breakpoint
ALTER TABLE "character_chat_state" DROP CONSTRAINT "character_chat_state_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "character_chat_summaries" DROP CONSTRAINT "character_chat_summaries_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "character_chat_summaries" DROP CONSTRAINT "character_chat_summaries_character_id_characters_id_fk";
--> statement-breakpoint
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_character_id_characters_id_fk";
--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_character_id_characters_id_fk";
--> statement-breakpoint
DROP INDEX "character_chat_messages_owner_character_idx";--> statement-breakpoint
DROP INDEX "episodes_chat_idx";--> statement-breakpoint
DROP INDEX "facts_chat_status_idx";--> statement-breakpoint
ALTER TABLE "character_chat_state" DROP CONSTRAINT "character_chat_state_owner_id_character_id_pk";--> statement-breakpoint
ALTER TABLE "character_chat_summaries" DROP CONSTRAINT "character_chat_summaries_owner_id_character_id_pk";--> statement-breakpoint
ALTER TABLE "character_chat_messages" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD CONSTRAINT "character_chat_state_chat_id_character_id_pk" PRIMARY KEY("chat_id","character_id");--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ADD CONSTRAINT "character_chat_summaries_chat_id_pk" PRIMARY KEY("chat_id");--> statement-breakpoint
CREATE INDEX "episodes_chat_group_idx" ON "episodes" USING btree ("chat_memory_group_id","turn_number");--> statement-breakpoint
CREATE INDEX "facts_chat_group_idx" ON "facts" USING btree ("chat_memory_group_id","status");--> statement-breakpoint
ALTER TABLE "character_chat_messages" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "character_chat_messages" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "character_chat_state" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "character_chat_summaries" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "character_chat_summaries" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "episodes" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "episodes" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "facts" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "facts" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_scope_exactly_one" CHECK ((
        ("episodes"."session_id" IS NOT NULL AND "episodes"."chat_memory_group_id" IS NULL) OR
        ("episodes"."session_id" IS NULL AND "episodes"."chat_memory_group_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_scope_exactly_one" CHECK ((
        ("facts"."session_id" IS NOT NULL AND "facts"."chat_memory_group_id" IS NULL) OR
        ("facts"."session_id" IS NULL AND "facts"."chat_memory_group_id" IS NOT NULL)
      ));