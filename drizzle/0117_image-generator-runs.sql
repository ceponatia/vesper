CREATE TABLE "image_generator_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model_slug" text NOT NULL,
	"requested_version_id" text,
	"executed_version_id" text,
	"prompt" text NOT NULL,
	"final_prompt" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"controls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_image_id" text,
	"failure_code" text,
	"error" text,
	"prediction_id" text,
	"source_run_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "image_generator_runs" ADD CONSTRAINT "image_generator_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generator_runs" ADD CONSTRAINT "image_generator_runs_result_image_id_images_id_fk" FOREIGN KEY ("result_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generator_runs" ADD CONSTRAINT "image_generator_runs_source_run_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."image_generator_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_generator_runs_owner_created_idx" ON "image_generator_runs" USING btree ("owner_id","created_at");