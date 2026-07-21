CREATE TABLE "sim_cohorts" (
	"branch_id" text NOT NULL,
	"cohort_id" text NOT NULL,
	"name" text NOT NULL,
	"population" integer NOT NULL,
	"presence_windows" jsonb NOT NULL,
	"registry_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_cohorts_branch_cohort_pk" PRIMARY KEY("branch_id","cohort_id"),
	CONSTRAINT "sim_cohorts_population_nonnegative" CHECK ("sim_cohorts"."population" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sim_means_bands" ADD COLUMN "cohort_id" text;--> statement-breakpoint
ALTER TABLE "sim_cohorts" ADD CONSTRAINT "sim_cohorts_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;