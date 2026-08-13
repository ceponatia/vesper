import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRegistryCore } from "./registry";
import { resolveProvenance, type Provenanced } from "./provenance";

interface Def {
  id: string;
  max: number;
}
const defs: Def[] = [
  { id: "a", max: 10 },
  { id: "b", max: 5 },
];
const core = buildRegistryCore<Def, number>({
  definitions: defs,
  idLabel: "widget",
  valueSchemaFor: (def) => z.number().min(0).max(def.max),
});

describe("buildRegistryCore", () => {
  it("indexes definitions and parses per-id with the def's schema", () => {
    expect(core.byId("a")?.max).toBe(10);
    expect(core.parseValue("a", 7)).toEqual({ ok: true, value: 7 });
    expect(core.parseValue("b", 7).ok).toBe(false); // exceeds b.max
  });

  it("unknown id fails with the configured label, not a throw", () => {
    const r = core.parseValue("z", 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/unknown widget id/);
  });

  it("rejects duplicate ids with the configured label", () => {
    expect(() => buildRegistryCore<Def, number>({ definitions: [defs[0]!, defs[0]!], valueSchemaFor: () => z.number(), idLabel: "widget" })).toThrow(
      /Duplicate widget id/,
    );
  });

  it("runs the per-definition validate hook", () => {
    expect(() =>
      buildRegistryCore<Def, number>({
        definitions: [{ id: "bad", max: -1 }],
        valueSchemaFor: () => z.number(),
        validate: (def) => {
          if (def.max < 0) throw new Error(`max must be ≥ 0: ${def.id}`);
        },
      }),
    ).toThrow(/max must be ≥ 0/);
  });
});

describe("resolveProvenance", () => {
  const v = (id: string, value: number, source: Provenanced["source"]): Provenanced & { value: number } => ({ id, value, source });

  it("higher precedence wins; ties go to the later entry", () => {
    const out = resolveProvenance([v("x", 1, "base")], [v("x", 2, "creation"), v("x", 3, "manual")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe(3);
  });

  it("a low-precedence overlay never shadows a higher-precedence base", () => {
    const out = resolveProvenance([v("x", 9, "manual")], [v("x", 1, "narrative")]);
    expect(out[0]?.value).toBe(9);
  });
});
