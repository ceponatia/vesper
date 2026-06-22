CREATE TABLE "character_chat_summaries" (
	"owner_id" text NOT NULL,
	"character_id" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"watermark_at" timestamp with time zone,
	"watermark_id" text,
	"covered_exchanges" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_chat_summaries_owner_id_character_id_pk" PRIMARY KEY("owner_id","character_id")
);
--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ADD CONSTRAINT "character_chat_summaries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ADD CONSTRAINT "character_chat_summaries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;