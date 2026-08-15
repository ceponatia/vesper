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
 *
 * intimate-scene-lora.spec.md is the design these serve.
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
