CREATE TABLE "image_identity_pack_trial_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"cell_key" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"spec_json" jsonb NOT NULL,
	"result_json" jsonb,
	"output_image_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_identity_pack_trial_grades" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"pair_id" text NOT NULL,
	"cell_a_id" text NOT NULL,
	"cell_b_id" text NOT NULL,
	"left_is_a" boolean NOT NULL,
	"grades_json" jsonb NOT NULL,
	"reviewed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_identity_pack_trial_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config_json" jsonb NOT NULL,
	"verdicts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_cells" ADD CONSTRAINT "image_identity_pack_trial_cells_output_image_id_images_id_fk" FOREIGN KEY ("output_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_cells" ADD CONSTRAINT "image_identity_pack_trial_cells_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."image_identity_pack_trial_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_grades" ADD CONSTRAINT "image_identity_pack_trial_grades_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."image_identity_pack_trial_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_grades" ADD CONSTRAINT "image_identity_pack_trial_grades_cell_a_fk" FOREIGN KEY ("cell_a_id") REFERENCES "public"."image_identity_pack_trial_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_grades" ADD CONSTRAINT "image_identity_pack_trial_grades_cell_b_fk" FOREIGN KEY ("cell_b_id") REFERENCES "public"."image_identity_pack_trial_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_grades" ADD CONSTRAINT "image_identity_pack_trial_grades_reviewer_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_runs" ADD CONSTRAINT "image_identity_pack_trial_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_pack_trial_cells_run_cell_key_unique" ON "image_identity_pack_trial_cells" USING btree ("run_id","cell_key");--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_pack_trial_grades_run_pair_unique" ON "image_identity_pack_trial_grades" USING btree ("run_id","pair_id");--> statement-breakpoint
CREATE INDEX "image_identity_pack_trial_runs_owner_idx" ON "image_identity_pack_trial_runs" USING btree ("owner_id");