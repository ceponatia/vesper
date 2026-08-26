CREATE TABLE "narrator_prompt_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"template_language" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "narrator_prompt_revisions_template_revision_unique" UNIQUE("template_id","revision")
);
--> statement-breakpoint
CREATE TABLE "narrator_prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"current_revision_id" text,
	"duplicated_from_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "narrator_prompt_template_id" text;--> statement-breakpoint
ALTER TABLE "narrator_prompt_revisions" ADD CONSTRAINT "narrator_prompt_revisions_template_id_narrator_prompt_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."narrator_prompt_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrator_prompt_templates" ADD CONSTRAINT "narrator_prompt_templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "narrator_prompt_templates_owner_active_name_unique" ON "narrator_prompt_templates" USING btree ("owner_id",lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "narrator_prompt_templates_owner_updated_idx" ON "narrator_prompt_templates" USING btree ("owner_id","updated_at");--> statement-breakpoint
ALTER TABLE "character_chats" ADD CONSTRAINT "character_chats_narrator_prompt_template_id_narrator_prompt_templates_id_fk" FOREIGN KEY ("narrator_prompt_template_id") REFERENCES "public"."narrator_prompt_templates"("id") ON DELETE set null ON UPDATE no action;