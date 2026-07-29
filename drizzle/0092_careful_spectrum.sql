CREATE TABLE "chat_visual_memory" (
	"memory_group_id" text NOT NULL,
	"viewpoint_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features_before" jsonb,
	"applied_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_visual_memory_memory_group_id_viewpoint_id_subject_id_pk" PRIMARY KEY("memory_group_id","viewpoint_id","subject_id")
);
