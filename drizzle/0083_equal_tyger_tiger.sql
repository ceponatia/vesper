CREATE TABLE "sim_shadow_divergences" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"domain" text NOT NULL,
	"legacy" jsonb NOT NULL,
	"successor" jsonb NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"verdict" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sim_shadow_divergences" ADD CONSTRAINT "sim_shadow_divergences_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_shadow_divergences" ADD CONSTRAINT "sim_shadow_divergences_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_shadow_divergences_chat_idx" ON "sim_shadow_divergences" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "sim_shadow_divergences_verdict_idx" ON "sim_shadow_divergences" USING btree ("verdict");