/**
 * The provider-neutral identity lock the legacy SCENE prose builder still
 * emits (`prompts-scene-render.ts`). No character lane sends it any more —
 * the compiled programs' dialects own their endpoints' identity wording
 * (`subject.identity` → `dialect-qwen-2511.ts` / `dialect-prose-family.ts`) —
 * and this module leaves with that builder.
 */
export const PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";
