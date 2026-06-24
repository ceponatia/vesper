CREATE TABLE "character_chat_state" (
	"owner_id" text NOT NULL,
	"character_id" text NOT NULL,
	"meters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"affinity" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mind_note" text DEFAULT '' NOT NULL,
	"last_pulse_trace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"premise" text DEFAULT '' NOT NULL,
	"clock_minutes" integer DEFAULT 0 NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_chat_state_owner_id_character_id_pk" PRIMARY KEY("owner_id","character_id")
);
--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD CONSTRAINT "character_chat_state_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD CONSTRAINT "character_chat_state_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;