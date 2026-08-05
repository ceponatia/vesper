ALTER TABLE "image_models" ADD COLUMN "reference_transport" text DEFAULT 'file' NOT NULL;
--> statement-breakpoint
-- Wan 2.7 rejects Replicate's own uploaded-file URLs: its wrapper proxies
-- Alibaba's async API and validates the file extension of what it receives,
-- and the upload arrives at the model container without one
-- (`ValueError: Invalid image format ''`). Inlined bytes carry the type in the
-- URI, so the wrapper sees webp. Every other seeded model resolves the upload
-- URL fine and keeps the smaller payload.
UPDATE "image_models" SET "reference_transport" = 'data_url' WHERE "slug" = 'wan-video/wan-2.7-image-pro';
