/**
 * Routing parity for sim-routed chats (presentation-charter.plan.md §4;
 * engine.spec.operations.md §39 ruling 18): decide what one chat POST kind means
 * for a chat whose authority is the successor engine. **No operation on a
 * sim-routed chat ever falls back to the legacy narrator** — every kind either
 * maps to a successor exchange mode or is refused with a clear error.
 *
 * Pure and self-contained (no IO/server imports) so the route stays a thin shell
 * and the decision is unit-testable in the pure suite.
 */

/** The kinds a chat POST can carry (mirrors `sendBodySchema.kind` in the route). */
export type ChatPostKind = "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";

/**
 * The successor exchange modes `runSimChatExchange` understands:
 * - `send` — the player's line drives a real turn (existing behavior).
 * - `continue` / `open` — a real turn with NO player utterance (ruling 19); the
 *   span advances, the world may act, the render omits the player-turn block.
 *   `open` additionally records `simOpening` on the reply's meta.
 * - `retake` — re-render the SAME committed cut (regenerate/rerun, ruling 18):
 *   same events, fresh prose, the assistant row replaced in place.
 */
export type SimExchangeMode = "send" | "continue" | "open" | "retake";

/** The unsupported-operation refusal code the client/UI keys on. */
export const SIM_UNSUPPORTED_CODE = "sim_unsupported_operation";

export type SimOperationDecision =
  | { action: "run"; mode: SimExchangeMode }
  | { action: "refuse"; code: string; message: string };

/**
 * Map one POST kind (+ whether it carries attachments or an action chip) onto a
 * successor decision. Attachments and legacy action chips have no designed
 * successor semantics yet, so they are REFUSED (the UI hides the affordance);
 * every other kind runs. This is the single gate that makes the legacy pipeline
 * unreachable for a sim-routed chat.
 */
export function decideSimOperation(input: {
  kind: ChatPostKind;
  hasAttachments: boolean;
  hasAction: boolean;
}): SimOperationDecision {
  if (input.hasAttachments) {
    return {
      action: "refuse",
      code: SIM_UNSUPPORTED_CODE,
      message: "Photos aren't available in world-engine chats yet.",
    };
  }
  if (input.hasAction || input.kind === "action_beat") {
    // An action beat has no successor semantics. It reaches here either as the
    // legacy `action_beat` kind or as an `action` payload on another kind; both
    // refuse. Returning here also narrows `input.kind` to the successor-relevant
    // kinds below, so the switch is total WITHOUT an (impossible) action_beat case.
    return {
      action: "refuse",
      code: SIM_UNSUPPORTED_CODE,
      message: "Action chips aren't available in world-engine chats yet.",
    };
  }
  switch (input.kind) {
    case "send":
      return { action: "run", mode: "send" };
    case "continue":
      return { action: "run", mode: "continue" };
    case "open":
      return { action: "run", mode: "open" };
    // Regenerate and rerun both re-render the same committed cut (ruling 18).
    case "regenerate":
    case "rerun":
      return { action: "run", mode: "retake" };
  }
}
