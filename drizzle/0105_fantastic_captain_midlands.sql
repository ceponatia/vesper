CREATE TABLE "image_lab_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text,
	"character_id" text,
	"chat_id" text,
	"model_slug" text NOT NULL,
	"requested_version_id" text,
	"executed_version_id" text,
	"profile_id" text,
	"instruction" text DEFAULT '' NOT NULL,
	"final_prompt" text,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"control_image_id" text,
	"control_kind" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_image_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"verdict" text,
	"verdict_note" text,
	"prediction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_lab_experiments" ADD CONSTRAINT "image_lab_experiments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_lab_experiments" ADD CONSTRAINT "image_lab_experiments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_lab_experiments" ADD CONSTRAINT "image_lab_experiments_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_lab_experiments" ADD CONSTRAINT "image_lab_experiments_control_image_id_images_id_fk" FOREIGN KEY ("control_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_lab_experiments" ADD CONSTRAINT "image_lab_experiments_result_image_id_images_id_fk" FOREIGN KEY ("result_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_lab_experiments_owner_created_idx" ON "image_lab_experiments" USING btree ("owner_id","created_at");