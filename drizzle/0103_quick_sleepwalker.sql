CREATE TABLE "image_identity_pack_trial_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"identity_strategy" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"policy_version" text NOT NULL,
	"override_incomplete_review" boolean DEFAULT false NOT NULL,
	"decided_by_user_id" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_cells" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_cells" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_verdicts" ADD CONSTRAINT "image_identity_pack_trial_verdicts_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."image_identity_pack_trial_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_verdicts" ADD CONSTRAINT "image_identity_pack_trial_verdicts_decider_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_pack_trial_verdicts_run_combo_unique" ON "image_identity_pack_trial_verdicts" USING btree ("run_id","profile_id","identity_strategy");--> statement-breakpoint
CREATE INDEX "image_identity_pack_trial_cells_run_status_idx" ON "image_identity_pack_trial_cells" USING btree ("run_id","status");--> statement-breakpoint
ALTER TABLE "image_identity_pack_trial_runs" DROP COLUMN "verdicts_json";