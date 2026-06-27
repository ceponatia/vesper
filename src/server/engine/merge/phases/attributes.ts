import { attributeRegistry } from "@/contracts/attributes";
import { attributeValueSchema, overlaySourceMayChange, resolveAttributes } from "@/contracts/attributes/value";
import { diag } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { findParticipant } from "../grounding";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";
import { MAX_ATTRIBUTE_CHANGES } from "./caps";

/**
 * Shallow equality for attribute values (scalar or enum_list array). Used by the
 * inherent-change guard to skip a correction when the model only re-asserts the value
 * a character already has. Arrays compare order-insensitively (an enum_list is a set).
 */
function attributeValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    const sa = aa.map(String).sort();
    const sb = bb.map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return a === b;
}

// Attribute changes (rare, lasting): overlays with narrative provenance.
// Inherent traits (eye color, gender, species, bone structure) are protected — a
// narrative overlay may not rewrite them (overlaySourceMayChange). A rejected change
// drops with a diagnostic + a droppedEvents correction so the narrator is re-grounded
// next turn instead of the drift silently sticking and re-applying every turn.
export function phaseAttributes(ctx: PhaseContext, state: WorkingState): void {
  const { simulant, sink } = ctx;
  for (const change of simulant.attributeChanges.slice(0, MAX_ATTRIBUTE_CHANGES)) {
    const participant = findParticipant(change.participantName, state.participants);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `attribute change for "${change.participantName}" dropped`));
      continue;
    }
    const def = attributeRegistry.byId(change.attributeId);
    if (!def) {
      sink.push(diag("warn", "merge.attribute.unknown", `unknown attribute "${change.attributeId}" dropped`));
      continue;
    }
    if (!overlaySourceMayChange(def.mutability, "narrative")) {
      // Suppress a spurious correction when the model merely re-asserts the value that
      // already resolves — only correct on a real divergence.
      const current = resolveAttributes(participant.snapshot.attributes, participant.state.attributeOverlays).find(
        (v) => v.id === change.attributeId,
      )?.value;
      if (!attributeValuesEqual(current, change.value)) {
        sink.push(
          diag(
            "warn",
            "merge.attribute.inherent_change_rejected",
            `narrative change to inherent attribute "${change.attributeId}" dropped`,
            { context: { participant: participant.displayName, attributeId: change.attributeId } },
          ),
        );
        state.recordDrop(
          `${participant.displayName}'s ${def.label.toLowerCase()} is an inherent trait and did not change.`,
        );
      }
      continue;
    }
    const overlay = parseOrNull(
      attributeValueSchema,
      { id: change.attributeId, value: change.value, source: "narrative", note: change.note },
      sink,
      "merge.attributeChange",
    );
    if (!overlay) {
      sink.push(diag("warn", "merge.attribute.invalid", `attribute change for "${change.attributeId}" failed validation`));
      continue;
    }
    state.setAttributeOverlays(participant, [
      ...participant.state.attributeOverlays.filter((o) => !(o.id === overlay.id && o.source === "narrative")),
      overlay,
    ]);
  }
}
