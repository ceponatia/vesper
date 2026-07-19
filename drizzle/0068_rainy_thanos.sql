CREATE TABLE "sim_body_rhythms" (
	"branch_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"start_minute_of_day" integer NOT NULL,
	"end_minute_of_day" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_body_rhythms_branch_actor_kind_start_pk" PRIMARY KEY("branch_id","actor_id","kind","start_minute_of_day"),
	CONSTRAINT "sim_body_rhythms_minutes_range" CHECK ("sim_body_rhythms"."start_minute_of_day" >= 0 AND "sim_body_rhythms"."start_minute_of_day" <= 1439 AND "sim_body_rhythms"."end_minute_of_day" >= 0 AND "sim_body_rhythms"."end_minute_of_day" <= 1439)
);
--> statement-breakpoint
ALTER TABLE "sim_body_conditions" ADD COLUMN "ended_at" bigint;--> statement-breakpoint
ALTER TABLE "sim_body_rhythms" ADD CONSTRAINT "sim_body_rhythms_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;