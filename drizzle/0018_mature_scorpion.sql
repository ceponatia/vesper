ALTER TABLE "episodes" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "character_id" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "character_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episodes_chat_idx" ON "episodes" USING btree ("owner_id","character_id","turn_number");--> statement-breakpoint
CREATE INDEX "facts_chat_status_idx" ON "facts" USING btree ("owner_id","character_id","status");--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_scope_exactly_one" CHECK ((
        ("episodes"."session_id" IS NOT NULL AND "episodes"."owner_id" IS NULL AND "episodes"."character_id" IS NULL) OR
        ("episodes"."session_id" IS NULL AND "episodes"."owner_id" IS NOT NULL AND "episodes"."character_id" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_scope_exactly_one" CHECK ((
        ("facts"."session_id" IS NOT NULL AND "facts"."owner_id" IS NULL AND "facts"."character_id" IS NULL) OR
        ("facts"."session_id" IS NULL AND "facts"."owner_id" IS NOT NULL AND "facts"."character_id" IS NOT NULL)
      ));