import type { ImageProfileTask } from "../models/image-model-profiles";

/**
 * WHERE a render is being run from, as the LoRA rules need to know it.
 *
 * It exists because "can these weights run here?" and "may Vesper run them
 * here?" are two different questions, and the library evaluator was answering
 * only the merged one. A LoRA row carries both kinds of rule side by side:
 *
 * - **Mechanical compatibility** — the row is enabled, the weights were trained
 *   against this model, the version is one the reviewer vouched for, the scale
 *   sits inside both the curated band and the version's own binding, the version
 *   exposes the two LoRA fields, and the locator is retrievable. Every one of
 *   those is a fact about whether the prediction can physically succeed, so it
 *   holds no matter who is asking.
 * - **Production task policy** — `allowedTasks`: the reviewer's curation of which
 *   player-facing jobs this LoRA may serve. An anime style LoRA quietly applying
 *   to a character's canonical portrait is the failure that list prevents, and it
 *   is a POLICY about Vesper's product, not a claim about the weights.
 *
 * The bench is the case that forced the split. The Image Generator renders
 * nothing a player sees; it exists to prove what a model can do. Before this
 * type it had to borrow some production task to ask its question, which meant a
 * mechanically perfect LoRA was refused for failing a curation rule about a lane
 * the bench is not in.
 *
 * The three contexts, and why each answers the task question the way it does:
 *
 * - `production` — a player-facing lane (portrait, variant, scene…). Both checks
 *   apply, exactly as before this type existed.
 * - `generator_bench` — the Image Generator's admin bench. Mechanical checks
 *   only: it carries no task, and inventing one would be inventing the answer.
 * - `image_lab` — the Image Lab, which REPRODUCES a production render for
 *   evidence. It carries a real task and is judged by production's rules, so lab
 *   evidence stays evidence about the lane it is imitating.
 *
 * Runtime-only: nothing here is stored. A row's `allowedTasks` column is
 * unchanged, and so is the parsed `ImageLora` row — the concept split lives in the
 * evaluator and in these comments, not in a reshaped record.
 */
export type ImageExecutionContext =
  | { kind: "production"; task: ImageProfileTask }
  | { kind: "generator_bench" }
  | { kind: "image_lab"; task: ImageProfileTask };

/**
 * The task whose production policy this context is judged by, or null when no
 * policy applies.
 *
 * One function so "the bench skips task curation" is decided once. A caller that
 * re-derived it — a UI filter, a diagnostic that wants to name the task — would
 * be a second place for the bench exemption to be forgotten, which is precisely
 * how the Generator ended up borrowing a task it did not have.
 */
export function imageExecutionContextTask(context: ImageExecutionContext): ImageProfileTask | null {
  switch (context.kind) {
    case "production":
    case "image_lab":
      return context.task;
    case "generator_bench":
      return null;
  }
}
