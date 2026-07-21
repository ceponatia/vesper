ALTER TABLE "character_chats" ADD COLUMN "engine_authority" text DEFAULT 'legacy_chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "successor_rag_eligibility" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "sim_branch_id" text;--> statement-breakpoint
ALTER TABLE "character_chats" ADD CONSTRAINT "character_chats_sim_branch_id_sim_branches_id_fk" FOREIGN KEY ("sim_branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE set null ON UPDATE no action;