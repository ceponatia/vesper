-- Correct the FLUX.2 klein 4B female NSFW test LoRA locator after live
-- Replicate inference showed that this endpoint does not accept arbitrary URLs
-- despite its broad schema description. A Civitai download URL falls through
-- to Hugging Face repo-id parsing and fails before the LoRA can load.
--
-- Replicate's own working examples for
-- `black-forest-labs/flux-2-klein-4b-base-lora` pass a direct Hugging Face
-- `resolve/main/*.safetensors` URL. Use that exact supported shape here.
--
-- The mirrored artifact below is the same Civitai model 2331032 / version
-- 2633618 selected in migration 0143: 92,440,448 bytes, sha256
-- 3a178706776a6c7964f2d47820e55b9d09a065285050cb33d8cee2ecad18075f.
--
-- The predicate deliberately matches the locator 0143 wrote. If an operator
-- already corrected or replaced the row, this migration leaves that later
-- curation alone.
UPDATE "image_loras"
SET
  "locator_type" = 'https_url',
  "locator" = 'https://huggingface.co/Sentinel7/flux2/resolve/main/2331032/2633618/nipplediffusion-f2-klein-4b.safetensors'
WHERE
  "id" = 'imglorklein4bnsfwfemale'
  AND "locator_type" = 'civitai_model_version'
  AND "locator" = '2633618';
