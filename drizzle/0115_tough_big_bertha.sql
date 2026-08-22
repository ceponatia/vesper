ALTER TABLE "sim_shadow_divergences" DROP CONSTRAINT "sim_shadow_divergences_branch_id_sim_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "sim_shadow_divergences" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_shadow_divergences" ADD CONSTRAINT "sim_shadow_divergences_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE set null ON UPDATE no action;