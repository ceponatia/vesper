import { describe, expect, it } from "vitest";
import {
  affordancePerceptionView,
  crookedNoseAttributes,
  DiagnosticCollector,
  emptyVisualMemoryState,
} from "@/contracts";
import { degradedVisualStatePreviewPayload, visualStatePreviewPayload } from "./preview";
import { buildVisualStateShadow, type VisualStateShadowInput } from "./shadow";

/**
 * The inspector payload is plain JSON — no Maps, no branded classes, nothing a
 * route serializer would drop — and deterministic over one build, so two
 * refreshes of the panel against an unchanged cut render identically.
 */
describe("visualStatePreviewPayload", () => {
  const input: VisualStateShadowInput = {
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: "mg_preview" },
    cutId: "cut_preview",
    atMinutes: 10,
    subjectId: "vs_preview_subject",
    attributes: crookedNoseAttributes(),
    conditions: [],
    realize: {},
    perception: affordancePerceptionView({ exposure: { nose: "visible" }, channels: { sight: "available" } }),
    observerId: "owner_preview",
    observer: { kind: "player_viewpoint", viewpointId: "owner_preview" },
    memory: emptyVisualMemoryState(),
  };

  it("serializes one build losslessly through JSON", () => {
    const sink = new DiagnosticCollector();
    const build = buildVisualStateShadow({ ...input, sink });
    const payload = visualStatePreviewPayload({ build, shadowFlagEnabled: false, diagnostics: sink.items });
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
    expect(roundTripped).toEqual(payload);
    expect(payload.scopeKey).toBe("chat:mg_preview");
    expect(payload.features.length).toBe(build.snapshot.features.length);
    expect(payload.measurements).toEqual(build.measurements);
    // The realized render digest rides the same payload, and the round trip
    // above is what proves it stayed plain JSON — the image context it is
    // realized from carries Maps and Sets a route serializer would drop.
    expect(payload.imageDigest?.cutId).toBe(build.snapshot.cutId);
  });

  it("is deterministic over one cut", () => {
    const first = visualStatePreviewPayload({
      build: buildVisualStateShadow(input),
      shadowFlagEnabled: false,
      diagnostics: [],
    });
    const second = visualStatePreviewPayload({
      build: buildVisualStateShadow(input),
      shadowFlagEnabled: false,
      diagnostics: [],
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("degrades to an honestly empty payload carrying the diagnostics", () => {
    const payload = degradedVisualStatePreviewPayload({
      lane: "successor",
      shadowFlagEnabled: true,
      diagnostics: [{ severity: "error", code: "visual_state.shadow.failed", message: "boom" }],
    });
    expect(payload.features).toEqual([]);
    expect(payload.measurements.featureCount).toBe(0);
    expect(payload.diagnostics[0]?.code).toBe("visual_state.shadow.failed");
  });
});
