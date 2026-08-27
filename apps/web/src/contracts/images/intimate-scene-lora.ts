/**
 * PURE. The two names that identify the intimate-scene LoRA setup — the library
 * row and the endpoint that can load it.
 *
 * They live in contracts rather than beside the render route because BOTH sides
 * of the plan need them and they sit on opposite sides of a lint-enforced
 * boundary: the chat render path (`server/images/scene-lora.ts`) resolves the
 * route, and the Advanced Image Lab's staged-scene form defaults its model to
 * the same wrapper so a bench run reproduces production. A component may not
 * import `server/*`, so a constant that stayed there would be retyped as a
 * literal on the form — two spellings of one external fact, free to drift the
 * day the wrapper is re-registered under another slug.
 */

/**
 * The seeded library row the intimate route asks for
 * (`drizzle/0108_intimate-scene-lora.sql`) — "Qwen Image Edit 2511 NSFW all
 * inclusive" v2.0, the one LoRA whose training covers every acceptance act.
 *
 * Named by ID rather than searched for by label because the row is ordinary
 * after seeding: an admin may retune its scale band or switch it off, and the
 * route must follow those edits rather than re-find a row that looks similar.
 * A deleted row resolves to nothing and degrades, which is the documented
 * behavior of every stored image selection.
 */
export const INTIMATE_SCENE_LORA_ID = "imglorqwennsfwallinclv20";

/**
 * The LoRA-capable Qwen edit endpoint, as a BASE slug.
 *
 * Base, because the registered row carries a version pin (community models must
 * — the bare-slug endpoint is official-models-only), and the pin is the
 * operator's to change through the admin screens without this constant chasing
 * it. Resolution matches base-slug to base-slug, the image lab's own rule.
 *
 * It is also the only Qwen edit model that accepts `lora_weights` at all, which
 * is why the lab's staged-scene form defaults to it: pairing the seeded weights
 * with the ordinary scene model would settle the run `image_lora.incompatible`
 * before rendering.
 */
export const INTIMATE_SCENE_LORA_WRAPPER_SLUG = "qwen/qwen-image-edit-plus-lora";
/**
 * The one model whose selection PRE-FILLS the seeded row in the Image
 * Generator, as a base slug.
 *
 * This is a UI preference, not a compatibility claim, and the two must not be
 * conflated. `image_loras.compatible_model_slugs` answers "can these weights
 * run here?", and migration 0118 widened this row's answer to BOTH Qwen edit
 * endpoints once 2511 was confirmed to bind `lora_weights`/`lora_scale`. So
 * "the only compatible row" can no longer identify the pairing: deriving the
 * prefill from compatibility would arm it on the ordinary scene model too.
 *
 * What this constant records instead is why an operator reaches for the
 * wrapper at all. 2511 is the everyday editor and is picked for many reasons;
 * the plus-lora wrapper is a separate legacy endpoint kept precisely because it
 * loads these weights, so a run on it that carries no LoRA is the rare case.
 *
 * It is a default, never a lock — the select stays free to change or clear, and
 * a duplicated run's own recorded choice always wins over it.
 */
export const INTIMATE_SCENE_LORA_PREFILL_SLUG = INTIMATE_SCENE_LORA_WRAPPER_SLUG;
