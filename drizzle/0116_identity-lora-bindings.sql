CREATE TABLE "image_identity_lora_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_pack_id" text NOT NULL,
	"lora_id" text NOT NULL,
	"base_checkpoint" text NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"dataset_image_count" integer NOT NULL,
	"training_recipe_id" text NOT NULL,
	"training_recipe_revision" integer NOT NULL,
	"rank" integer NOT NULL,
	"trigger_token" text,
	"training_run_ref" text,
	"state" text DEFAULT 'experimental' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_identity_lora_bindings_rank_bounds" CHECK ("image_identity_lora_bindings"."rank" >= 1 AND "image_identity_lora_bindings"."rank" <= 128),
	CONSTRAINT "image_identity_lora_bindings_dataset_size" CHECK ("image_identity_lora_bindings"."dataset_image_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "image_identity_lora_bindings" ADD CONSTRAINT "image_identity_lora_bindings_identity_pack_id_image_identity_packs_id_fk" FOREIGN KEY ("identity_pack_id") REFERENCES "public"."image_identity_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_lora_bindings" ADD CONSTRAINT "image_identity_lora_bindings_lora_id_image_loras_id_fk" FOREIGN KEY ("lora_id") REFERENCES "public"."image_loras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_identity_lora_bindings_pack_idx" ON "image_identity_lora_bindings" USING btree ("identity_pack_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_lora_bindings_one_active_per_pack" ON "image_identity_lora_bindings" USING btree ("identity_pack_id") WHERE state = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_lora_bindings_pack_lora_unique" ON "image_identity_lora_bindings" USING btree ("identity_pack_id","lora_id");