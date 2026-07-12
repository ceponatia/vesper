CREATE TABLE "character_chat_relationships" (
	"chat_id" text NOT NULL,
	"from_character_id" text NOT NULL,
	"to_character_id" text NOT NULL,
	"record" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_chat_relationships_chat_id_from_character_id_to_character_id_pk" PRIMARY KEY("chat_id","from_character_id","to_character_id")
);
--> statement-breakpoint
CREATE TABLE "character_relationships" (
	"from_character_id" text NOT NULL,
	"to_character_id" text NOT NULL,
	"record" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_relationships_from_character_id_to_character_id_pk" PRIMARY KEY("from_character_id","to_character_id")
);
--> statement-breakpoint
ALTER TABLE "character_chat_relationships" ADD CONSTRAINT "character_chat_relationships_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_relationships" ADD CONSTRAINT "character_chat_relationships_from_character_id_characters_id_fk" FOREIGN KEY ("from_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_relationships" ADD CONSTRAINT "character_chat_relationships_to_character_id_characters_id_fk" FOREIGN KEY ("to_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_relationships" ADD CONSTRAINT "character_relationships_from_character_id_characters_id_fk" FOREIGN KEY ("from_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_relationships" ADD CONSTRAINT "character_relationships_to_character_id_characters_id_fk" FOREIGN KEY ("to_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;