/**
 * Curated **scene composer** model options — the shot planner that turns chat state
 * into the structured `sceneSpecSchema` object every scene render is built from
 * (`server/images/prompts-scene-composer.ts`). One pure list shared by the admin
 * dropdown (components/chat/scene-composer-select.tsx) and the server's
 * `sceneComposerModelId` resolver (server/ai/provider.ts). Ids are OpenRouter slugs.
 *
 * Out of scope by design: the narrator (narrative-models.ts), the in-session agents
 * (agent-models.ts), and the image models themselves (the `image_models` registry —
 * this list is the TEXT model that plans the shot, never the one that paints it).
 *
 * ## Why the composer gets its own list at all
 *
 * The composer is a **structured-output** call over the most explicit stretch of a
 * chat, and those two facts pull in opposite directions. A moderation-prone model
 * answers an intimate beat with vague poses ("close to the viewer, intimate"), which
 * is a grounding failure before it is a moderation one — the render then gets anatomy
 * with no act (owner ruling 2026-08-10). A permissive model that cannot emit clean
 * JSON is no better: it degrades to the schema defaults, which parse and look exactly
 * like a composition.
 *
 * So every entry here must clear BOTH bars, and the A/B that measures them is
 * `scripts/eval/scene-images/composer-model-ab.ts` — it runs the real system prompt,
 * the real schema and the real evidence gates over the seven fixture beats, four of
 * them explicitly intimate. **An id belongs on this list once that probe has run it**,
 * with the verdict recorded in `docs/developer-notes/composer-model.spec.md`.
 *
 * Nothing here needs tool calling or `response_format`: `generateChecked` sends the
 * JSON Schema as TEXT and parses the reply locally, deliberately not using
 * provider-side constrained decoding (which degenerated on some models —
 * followups.phase2.md #20). That is why Aion 2.0, which advertises no structured-output
 * support, is a legitimate candidate.
 */

export interface SceneComposerModelOption {
  /** OpenRouter model id, e.g. "aion-labs/aion-3.0". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /**
   * One line of operator-facing guidance, shown under the admin dropdown. Says what
   * this model costs you and what it is good at — the whole reason an admin would move
   * a chat off the default.
   */
  description: string;
}

/**
 * The curated set. Ordered cheapest-blended-cost LAST is deliberately NOT the rule:
 * the control sits first because it is the model every other row is measured against,
 * and the rest run roughly fastest-first, which is the axis an operator is switching on.
 */
export const SCENE_COMPOSER_MODELS: readonly SceneComposerModelOption[] = [
  {
    id: "aion-labs/aion-3.0",
    label: "Aion 3.0 (control)",
    description: "The shipped default. Most permissive, most expensive, and slowest — reasoning is mandatory on this endpoint.",
  },
  {
    id: "aion-labs/aion-3.0-mini",
    label: "Aion 3.0 Mini",
    description: "Same lab as the control, ~4× cheaper. The safe landing spot if a flash model refuses intimate beats.",
  },
  {
    id: "aion-labs/aion-2.0",
    label: "Aion 2.0",
    description: "The session narrator's model. Permissive and proven on this repo's most explicit text; no structured-output support needed.",
  },
  {
    id: "~deepseek/deepseek-v4-flash-latest",
    label: "DeepSeek 4 Flash",
    description: "The in-session agent default — fast, ~44× cheaper than the control on tokens, and already trusted with structured JSON.",
  },
  {
    id: "qwen/qwen3.7-flash",
    label: "Qwen3.7 Flash",
    description: "The cheapest capable arm. Fast classifier-class model with a very large context window.",
  },
  {
    id: "z-ai/glm-4.7-flash",
    label: "GLM 4.7 Flash",
    description: "Flash-tier sibling of the curated GLM narrator. Cheap input, pricier output than the other flash rows.",
  },
  {
    id: "inclusionai/ling-3.0-flash",
    label: "Ling 3.0 Flash",
    description: "The cheapest model on the board. Included as the floor — if quality holds here, nothing beats it on price.",
  },
] as const;

/**
 * The composer model used when the chat has no admin override.
 *
 * Aion 3.0 is the character-chat narrative default (narrative-models.ts), so it is
 * already proven on this repo's most explicit text. Flipped onto the composer's own
 * seam ahead of the slice-2 probe on owner instruction (2026-08-14).
 *
 * **It is also the slowest and priciest option by a wide margin** — $3/$6 per M against
 * DeepSeek 4 Flash's $0.0675/$0.135, and the AionLabs endpoint mandates reasoning
 * (`reasoning:{enabled:false}` is rejected there), so every composer call silently pays
 * for a reasoning trace nothing reads. Moving this default is what
 * `scripts/eval/scene-images/composer-model-ab.ts` exists to justify; until that probe
 * has an owner verdict, the default stays where the ruling put it.
 */
export const DEFAULT_SCENE_COMPOSER_MODEL_ID = "aion-labs/aion-3.0";

/**
 * Resolve a persisted/over-the-wire composer id to a curated one. STRICT, for the
 * reason every other model resolver in this app is strict (codebase-review B3):
 * without it an authenticated user could bill arbitrary OpenRouter slugs — frontier
 * models included — to the deployment's key through a chat PATCH.
 *
 * An empty value means "no override", which is the overwhelmingly common case and not
 * an error. An unrecognised one is: it is a dropped registry entry or a typo, and both
 * should land on the default rather than 404 a render.
 */
export function resolveSceneComposerModelId(id: string | null | undefined): string {
  const trimmed = id?.trim();
  if (!trimmed) return DEFAULT_SCENE_COMPOSER_MODEL_ID;
  return SCENE_COMPOSER_MODELS.some((option) => option.id === trimmed)
    ? trimmed
    : DEFAULT_SCENE_COMPOSER_MODEL_ID;
}
